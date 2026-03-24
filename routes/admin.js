const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Kết nối DB đã tạo [cite: 85]

const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const customerController = require('../controllers/customerController');
const kpiController = require('../controllers/kpiController');
const recruitmentController = require('../controllers/recruitmentController');

// Cấu hình Multer lưu tạm vào bộ nhớ đệm (RAM) trước khi nén
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // Giới hạn file 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Chỉ chấp nhận định dạng ảnh!'));
    }
});

// Hàm hỗ trợ xử lý ảnh hệ thống (Tái sử dụng)
async function processSystemImage(fileBuffer, type) {
    const fileName = `${type}-${Date.now()}.webp`;
    const uploadDir = path.join(__dirname, '../public/uploads/system');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    let transform = sharp(fileBuffer);
    if (type === 'logo') {
        transform = transform.resize({ height: 100 }); // Logo cao 100px
    } else {
        transform = transform.resize({ width: 1200 }); // Banner rộng 1200px
    }

    await transform.webp({ quality: 80 }).toFile(path.join(uploadDir, fileName));
    return `/uploads/system/${fileName}`;
}

// Middleware kiểm tra quyền Admin
const isAdmin = (req, res, next) => {
    if (req.session.role === 'Admin') return next();
    res.redirect('/auth/login');
};

// 1. Trang Dashboard (Báo cáo KPI tổng hợp)
router.get('/dashboard', isAdmin, async (req, res) => {
    try {
        // Sử dụng COUNT() để tính toán trực tiếp trên Database giúp tiết kiệm RAM
        const [[{ total_customers }]] = await db.execute('SELECT COUNT(*) as total_customers FROM Customers WHERE is_deleted = 0');
        const [[{ total_staff }]] = await db.execute('SELECT COUNT(*) as total_staff FROM Users WHERE role = "Staff" AND is_deleted = 0');

        // Đếm số lượng ứng viên mới (Mới ứng tuyển)
        const [[{ newCandidatesCount }]] = await db.execute('SELECT COUNT(*) as newCandidatesCount FROM Users WHERE work_status = "APPLIED"');

        // Lấy sự kiện sắp diễn ra (5 sự kiện gần nhất tính từ hiện tại)
        const [upcoming_events] = await db.execute(
            'SELECT id, event_name, start_time, location FROM Events WHERE start_time >= NOW() ORDER BY start_time ASC LIMIT 5'
        );

        // Lấy khách hàng có sinh nhật trong 30 ngày tới
        const [upcoming_birthdays] = await db.execute(`
            SELECT id, full_name, phone_1, birthday 
            FROM Customers 
            WHERE is_deleted = 0 AND birthday IS NOT NULL 
            AND (
                DATE_FORMAT(birthday, '%m-%d') BETWEEN DATE_FORMAT(NOW(), '%m-%d') AND DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 30 DAY), '%m-%d')
                OR 
                (MONTH(NOW()) = 12 AND DATE_FORMAT(birthday, '%m-%d') <= DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 30 DAY), '%m-%d'))
            )
            ORDER BY MONTH(birthday) ASC, DAY(birthday) ASC 
            LIMIT 10
        `);

        // Lấy thông tin họ tên từ bảng Users
        const [users] = await db.execute('SELECT full_name, dashboard_layout, mobile_layout FROM Users WHERE id = ?', [req.session.userId]);
        const full_name = users.length > 0 ? users[0].full_name : req.session.username;

        res.render('admin/dashboard', {
            full_name,
            total_customers,
            total_staff,
            newCandidatesCount,
            upcoming_events,
            customers_birthday: upcoming_birthdays,
            dashboard_layout: users.length > 0 && users[0].dashboard_layout ? users[0].dashboard_layout : '[]',
            mobile_layout: users.length > 0 && users[0].mobile_layout ? users[0].mobile_layout : '[]'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải dữ liệu Dashboard');
    }
});

// 2. Trang Quản lý Tag (Lấy danh sách Tag)
router.get('/tags', isAdmin, async (req, res) => {
    try {
        // Chỉ lấy các cột cần thiết để tiết kiệm RAM [cite: 98, 111]
        const [tags] = await db.execute('SELECT id, tag_name, color_code FROM Tags');
        res.render('admin/tags', { tags });
    } catch (err) {
        res.status(500).send('Lỗi lấy dữ liệu Tag');
    }
});

// 3. Xử lý thêm Tag mới
router.post('/tags/add', isAdmin, async (req, res) => {
    const { tag_name, color_code } = req.body;
    try {
        await db.execute('INSERT INTO Tags (tag_name, color_code) VALUES (?, ?)', [tag_name, color_code]);
        res.redirect('/admin/tags');
    } catch (err) {
        res.status(500).send('Lỗi khi thêm Tag');
    }
});

// Hàm hỗ trợ ghi Log (Đã thêm targetUserId)
const logAction = async (userId, targetUserId, actionType, content) => {
    try {
        await db.execute(
            'INSERT INTO Action_Logs (user_id, target_user_id, action_type, content) VALUES (?, ?, ?, ?)',
            [userId, targetUserId, actionType, content]
        );
    } catch (error) {
        console.error('Lỗi ghi log:', error);
    }
};

// Hàm loại bỏ ký tự lạ, chỉ giữ lại số
const cleanToNumbers = (val) => val ? val.replace(/\D/g, '') : null;

// ==========================================
// CORE: BỘ MÁY TÍNH TOÁN ĐIỂM KPI TỐI ƯU RAM
// ==========================================
async function calculateLeaderboard(month, year) {
    // 1. Lấy cấu hình KPI của tháng
    const [configs] = await db.execute('SELECT * FROM KPI_Configs WHERE month = ? AND year = ?', [month, year]);
    if (configs.length === 0) return { config: null, leaderboard: [], teams: [] };
    const config = configs[0];

    // Lấy danh sách sự kiện được tính KPI trong tháng
    const [kpiEvents] = await db.execute('SELECT event_id FROM KPI_Config_Events WHERE config_id = ?', [config.id]);
    const validEventIds = kpiEvents.map(e => e.event_id);
    const eventFilter = validEventIds.length > 0 ? `AND ep.event_id IN (${validEventIds.join(',')})` : `AND 1=0`; // Nếu không có sự kiện nào thì count = 0

    // 2. Truy vấn gom nhóm (GROUP BY) lấy điểm từ 3 nguồn: Khách sự kiện, Khảo sát, Khách mới
    const sql = `
        SELECT 
            u.id, u.full_name, u.avatar_url, u.leader_id,
            (SELECT COUNT(*) FROM Event_Participants ep JOIN Customers c ON ep.customer_id = c.id WHERE c.staff_id = u.id AND ep.status = 'Đã tham dự' ${eventFilter}) as event_count,
            (SELECT COUNT(*) FROM Surveys s JOIN Customers c ON s.customer_id = c.id WHERE c.staff_id = u.id AND MONTH(s.completed_at) = ? AND YEAR(s.completed_at) = ?) as survey_count,
            (SELECT COUNT(*) FROM Customers c2 WHERE c2.staff_id = u.id AND MONTH(c2.created_at) = ? AND YEAR(c2.created_at) = ? AND c2.is_deleted = 0) as new_cust_count
        FROM Users u 
        WHERE u.role = 'Staff' AND u.is_deleted = 0
    `;

    const [staffStats] = await db.execute(sql, [month, year, month, year]);

    // 3. Tính điểm cá nhân
    let staffList = staffStats.map(staff => {
        const p_events = staff.event_count * config.point_per_attended_event;
        const p_surveys = staff.survey_count * config.point_per_survey;
        const p_customers = staff.new_cust_count * config.point_per_new_customer;

        return {
            ...staff,
            personal_points: p_events + p_surveys + p_customers,
            team_bonus: 0,
            total_points: 0
        };
    });

    // 4. Tính điểm Trưởng nhóm (Overriding)
    staffList.forEach(leader => {
        // Tìm những lính thuộc quyền quản lý của người này
        const teamMembers = staffList.filter(sub => sub.leader_id === leader.id);
        if (teamMembers.length > 0) {
            const teamTotalPoints = teamMembers.reduce((sum, sub) => sum + sub.personal_points, 0);
            leader.team_bonus = Math.round(teamTotalPoints * config.tl_coefficient); // Nhân hệ số (VD: 10%)
        }
        leader.total_points = leader.personal_points + leader.team_bonus;
    });

    // 5. Xếp hạng giảm dần theo Tổng điểm
    staffList.sort((a, b) => b.total_points - a.total_points);

    // Xếp hạng (Xử lý đồng điểm)
    let currentRank = 1;
    for (let i = 0; i < staffList.length; i++) {
        if (i > 0 && staffList[i].total_points < staffList[i - 1].total_points) {
            currentRank = i + 1;
        }
        staffList[i].rank = currentRank;
    }

    return { config, leaderboard: staffList };
}

// 4. Trang Quản lý Nhân sự (Xem danh sách Staff & Lịch sử)
router.get('/staff-management', isAdmin, async (req, res) => {
    try {
        // CẬP NHẬT: Thêm cột `gender` vào câu lệnh SELECT
        const [staffs] = await db.execute(
            `SELECT id, username, full_name, role, gender, is_locked, lock_message, can_recruit,
                    birthday, cccd, phone_1, phone_2, business_code, email, address, 
                    work_area, start_date, end_date, avatar_url, leader_id, probation_start_date, probation_end_date
             FROM Users 
             WHERE role = "Staff" AND is_deleted = 0`
        );

        // Lấy lịch sử thao tác của các nhân viên
        const [logs] = await db.execute(`
            SELECT al.target_user_id, al.content, al.created_at, u.username as actor_name
            FROM Action_Logs al
            LEFT JOIN Users u ON al.user_id = u.id
            WHERE al.target_user_id IS NOT NULL
            ORDER BY al.created_at DESC
        `);

        staffs.forEach(staff => {
            staff.history = logs.filter(log => log.target_user_id === staff.id);
        });

        const [leaders] = await db.execute('SELECT id, full_name FROM Users WHERE role = "Staff" AND is_deleted = 0');
        res.render('admin/staff', { staffs, leaders });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi lấy danh sách nhân sự');
    }
});

// =============================================
// 5a. Xử lý THÊM nhân viên mới
// =============================================

router.post('/staff/add', isAdmin, async (req, res) => {
    const {
        full_name, username, password, gender, birthday, cccd,
        phone_1, phone_2, email, business_code, work_area,
        address, start_date, end_date, leader_id, probation_start_date, probation_end_date, can_recruit
    } = req.body;

    try {
        const [existing] = await db.execute('SELECT id FROM Users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.send('<script>alert("Tên đăng nhập đã tồn tại!"); window.history.back();</script>');
        }

        await db.execute(`
            INSERT INTO Users (
                full_name, username, password, role, gender, birthday, cccd, 
                phone_1, phone_2, email, business_code, work_area, 
                address, start_date, end_date, leader_id, probation_start_date, probation_end_date, can_recruit
            ) VALUES (?, ?, ?, 'Staff', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            full_name.trim().toUpperCase(), // ĐÃ SỬA: Ép in hoa và xóa khoảng trắng thừa
            username.trim().toLowerCase(),
            password,
            gender || 'Chưa xác định',
            birthday || null,
            cccd,
            phone_1,
            phone_2 || null,
            email || null,
            business_code || null,
            work_area || null,
            address || null,
            start_date || null,
            end_date || null,
            leader_id || null,
            probation_start_date || null,
            probation_end_date || null,
            can_recruit === '1' ? 1 : 0
        ]);

        // ĐÃ SỬA LỖI CRASH: Sử dụng hàm logAction đồng bộ với Action_Logs
        await logAction(req.session.userId, null, 'TẠO TÀI KHOẢN', `Tạo tài khoản nhân viên mới: @${username}`);

        res.redirect('/admin/staff-management');
    } catch (err) {
        console.error('Lỗi tạo nhân viên:', err);
        res.status(500).send('Lỗi máy chủ khi tạo nhân viên');
    }
});

// 5b. Xử lý CẬP NHẬT thông tin nhân viên
router.post('/staff/edit/:id', isAdmin, async (req, res) => {
    const {
        full_name, password, gender, birthday, cccd,
        phone_1, phone_2, business_code, email, work_area,
        address, start_date, end_date, leader_id, probation_start_date, probation_end_date, can_recruit
    } = req.body;
    const staffId = req.params.id;

    try {
        // =========================================================
        // KIỂM TRA CHỐNG VÒNG LẶP & LOGIC TRƯỞNG NHÓM
        // =========================================================
        if (leader_id) {
            // 1. Không thể tự chọn chính mình
            if (leader_id == staffId) {
                return res.send('<script>alert("🛑 Lỗi: Nhân viên không thể tự làm trưởng nhóm của chính mình!"); window.history.back();</script>');
            }
            
            // 2. Thuật toán Dò ngược (Trace Up) chống vòng lặp nhiều tầng
            let traceLeaderId = leader_id;
            let loopCount = 0; // Giới hạn 50 cấp để chống treo Server nếu DB đã lỡ bị loop từ trước
            
            while (traceLeaderId && loopCount < 50) {
                const [traceRes] = await db.execute('SELECT leader_id FROM Users WHERE id = ? AND is_deleted = 0 AND is_locked = 0', [traceLeaderId]);
                if (traceRes.length === 0) break; // Nếu không tìm thấy hoặc người này bị khóa/xóa thì dừng
                
                traceLeaderId = traceRes[0].leader_id;
                if (traceLeaderId == staffId) {
                    return res.send('<script>alert("🛑 Lỗi vòng lặp cơ cấu: Bạn đang gán một người làm cấp dưới cho chính nhân viên của họ (Ví dụ: A quản lý B, B quản lý C, C quản lý A). Vui lòng kiểm tra lại!"); window.history.back();</script>');
                }
                loopCount++;
            }
        }
        // =========================================================

        let sql = `
            UPDATE Users SET 
            full_name = ?, gender = ?, birthday = ?, cccd = ?, phone_1 = ?, phone_2 = ?, 
            business_code = ?, email = ?, work_area = ?, address = ?, 
            start_date = ?, end_date = ?, leader_id = ?, probation_start_date = ?, probation_end_date = ?, can_recruit = ?
        `;
        let params = [
            full_name.trim().toUpperCase(), // ĐÃ SỬA: Ép in hoa và xóa khoảng trắng thừa
            gender || 'Chưa xác định',
            birthday || null,
            cccd,
            phone_1,
            phone_2 || null,
            business_code || null,
            email || null,
            work_area || null,
            address || null,
            start_date || null,
            end_date || null,
            leader_id || null,
            probation_start_date || null,
            probation_end_date || null,
            can_recruit === '1' ? 1 : 0
        ];

        // Nếu admin có nhập mật khẩu mới thì cập nhật luôn
        if (password && password.trim() !== '') {
            sql += `, password = ?`;
            params.push(password);
        }

        sql += ` WHERE id = ?`;
        params.push(staffId);

        await db.execute(sql, params);

        // ĐÃ SỬA LỖI CRASH: Sử dụng hàm logAction đồng bộ với Action_Logs
        await logAction(req.session.userId, staffId, 'CẬP NHẬT', 'Cập nhật thông tin hồ sơ nhân viên');

        res.redirect('/admin/staff-management');
    } catch (err) {
        console.error('Lỗi cập nhật nhân viên:', err);
        res.status(500).send('Lỗi máy chủ khi cập nhật thông tin');
    }
});

// Xử lý ĐẶT LẠI MẬT KHẨU nhân viên (Dành cho Admin)
router.post('/staff/change-password/:id', isAdmin, async (req, res) => {
    const staffId = req.params.id;
    const { new_password } = req.body;
    try {
        await db.execute(
            'UPDATE Users SET password = ? WHERE id = ?',
            [new_password, staffId]
        );
        await logAction(req.session.userId, staffId, 'CHANGE_PASSWORD', `Admin đặt lại mật khẩu cho nhân viên`);
        res.redirect('/admin/staff-management');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi cập nhật mật khẩu');
    }
});

// 5c. Xử lý XÓA nhân viên (Xóa mềm - Lưu thời gian xóa)
router.post('/staff/delete/:id', isAdmin, async (req, res) => {
    const staffId = req.params.id;
    try {
        // Cập nhật is_deleted = 1 và lưu thời gian deleted_at = NOW()
        await db.execute('UPDATE Users SET is_deleted = 1, is_locked = 1, lock_message = "Tài khoản đã bị xóa", deleted_at = NOW() WHERE id = ?', [staffId]);
        await logAction(req.session.userId, staffId, 'DELETE_STAFF', `Chuyển nhân viên vào danh sách Đã xóa`);
        res.redirect('/admin/staff-management');
    } catch (err) {
        res.status(500).send('Lỗi khi xóa nhân viên.');
    }
});

// 5d. Xử lý KHÓA/MỞ KHÓA nhân viên
router.post('/staff/toggle-lock/:id', isAdmin, async (req, res) => {
    const staffId = req.params.id;
    const { is_locked, lock_message } = req.body;
    try {
        await db.execute(
            'UPDATE Users SET is_locked = ?, lock_message = ? WHERE id = ?',
            [is_locked, is_locked === '1' ? lock_message : null, staffId]
        );

        // Định dạng câu Log đúng chuẩn yêu cầu
        const logMsg = is_locked === '1' ? `khóa: Lý do ${lock_message}` : `mở khóa tài khoản`;
        await logAction(req.session.userId, staffId, 'LOCK_STAFF', logMsg);

        res.redirect('/admin/staff-management');
    } catch (err) {
        res.status(500).send('Lỗi cập nhật trạng thái');
    }
});

// 5e. Xem chi tiết nhân viên và lịch sử thao tác
router.get('/staff/detail/:id', isAdmin, async (req, res) => {
    try {
        const staffId = req.params.id;

        // 1. Lấy thông tin nhân viên
        const [staff] = await db.execute(`
            SELECT * FROM Users WHERE id = ? AND role = 'Staff'
        `, [staffId]);

        if (staff.length === 0) return res.status(404).send('Không tìm thấy nhân viên');

        // 2. Lấy lịch sử thao tác (Logs do nhân viên này thực hiện hoặc tác động lên nhân viên này)
        const [logs] = await db.execute(`
            SELECT al.*, u.full_name as actor_name 
            FROM Action_Logs al
            LEFT JOIN Users u ON al.user_id = u.id
            WHERE al.user_id = ? OR al.target_user_id = ?
            ORDER BY al.created_at DESC
        `, [staffId, staffId]);

        res.render('admin/staff-detail', { staff: staff[0], logs });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải chi tiết nhân viên');
    }
});

// 8. Trang Báo cáo & Thống kê chi tiết (Nâng cấp bộ lọc đa chọn)
router.get('/reports', isAdmin, async (req, res) => {
    // Nhận mảng ID từ query (Express tự động chuyển thành mảng nếu chọn nhiều)
    let staff_ids = req.query.staff_ids || [];
    if (!Array.isArray(staff_ids)) staff_ids = [staff_ids];

    let tag_ids = req.query.tag_ids || [];
    if (!Array.isArray(tag_ids)) tag_ids = [tag_ids];

    const { start_date, end_date } = req.query;
    const keyword = req.query.keyword || ''; // Lấy từ khóa tìm kiếm

    // Lấy danh sách cột cần hiển thị, mặc định hiện tất cả nếu chưa chọn 
    const show_cols = req.query.show_cols || ['created_at', 'full_name', 'phone_1', 'staff_name', 'tag_names'];

    try {
        const [staffList] = await db.execute('SELECT id, full_name FROM Users WHERE role = "Staff" AND is_deleted = 0');
        const [tagList] = await db.execute('SELECT id, tag_name FROM Tags');

        let sql = `
            SELECT c.id, c.full_name, c.phone_1, c.created_at, u.full_name as staff_name,
            GROUP_CONCAT(t.tag_name SEPARATOR ',') as tag_names,
            GROUP_CONCAT(t.color_code SEPARATOR ',') as tag_colors
            FROM Customers c
            LEFT JOIN Users u ON c.staff_id = u.id
            LEFT JOIN Customer_Tags ct ON c.id = ct.customer_id
            LEFT JOIN Tags t ON ct.tag_id = t.id
            WHERE c.is_deleted = 0
        `;
        const params = [];

        // Lọc theo danh sách nhiều nhân viên 
        if (staff_ids.length > 0) {
            sql += ` AND c.staff_id IN (${staff_ids.map(() => '?').join(',')})`;
            staff_ids.forEach(id => params.push(id));
        }

        // Lọc theo danh sách nhiều Tag [cite: 5]
        if (tag_ids.length > 0) {
            sql += ` AND EXISTS (SELECT 1 FROM Customer_Tags ct2 WHERE ct2.customer_id = c.id AND ct2.tag_id IN (${tag_ids.map(() => '?').join(',')}))`;
            tag_ids.forEach(id => params.push(id));
        }

        if (start_date) {
            sql += ` AND c.created_at >= ?`;
            params.push(`${start_date} 00:00:00`);
        }
        if (end_date) {
            sql += ` AND c.created_at <= ?`;
            params.push(`${end_date} 23:59:59`);
        }

        // --- BỘ LỌC TÌM KIẾM MỚI (TÊN HOẶC SĐT) ---
        if (keyword.trim() !== '') {
            sql += ` AND (c.full_name LIKE ? OR c.phone_1 LIKE ?)`;
            params.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`);
        }

        sql += ` GROUP BY c.id ORDER BY c.created_at DESC`;

        const [customers] = await db.execute(sql, params);

        res.render('admin/reports', {
            customers,
            staffList,
            tagList,
            show_cols,
            query: { ...req.query, staff_ids, tag_ids, keyword } // Trả keyword về UI
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi hệ thống báo cáo');
    }
});

// ==========================================
// CHI TIẾT KHÁCH HÀNG & GIÁM SÁT NHẬT KÝ (ADMIN)
// ==========================================
// XEM CHI TIẾT KHÁCH HÀNG & GIÁM SÁT NHẬT KÝ (ADMIN)
router.get('/customers/detail/:id', isAdmin, async (req, res) => {
    try {
        const customerId = req.params.id;

        // 1. Lấy thông tin khách hàng kèm theo Tên, SĐT và Avatar nhân viên
        const [customers] = await db.execute(`
    SELECT c.*, u.full_name as staff_name, u.phone_1 as staff_phone, u.avatar_url as staff_avatar 
    FROM Customers c 
    LEFT JOIN Users u ON c.staff_id = u.id 
    WHERE c.id = ?`, [customerId]
        );

        if (customers.length === 0) {
            return res.status(404).send('Không tìm thấy hồ sơ khách hàng.');
        }

        // 2. Lấy toàn bộ lịch sử chăm sóc (Notes)
        const [notes] = await db.execute(`
            SELECT n.*, u.full_name as author_name 
            FROM Customer_Notes n 
            LEFT JOIN Users u ON n.staff_id = u.id 
            WHERE n.customer_id = ? 
            ORDER BY n.created_at DESC
        `, [customerId]);

        // --- BỔ SUNG ĐOẠN NÀY ---
        // Lấy danh sách Lịch sử Active
        const [activeHistories] = await db.execute('SELECT * FROM Active_Histories WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at DESC', [customerId]);

        // 3. Lấy danh sách nhân viên để Modal sửa có dữ liệu để chọn người phụ trách
        const [staffs] = await db.execute("SELECT id, full_name FROM Users WHERE role = 'Staff' AND is_deleted = 0");
        // -----------------------

        // Truyền thêm biến staffs vào render
        res.render('admin/customer-detail', {
            customer: customers[0],
            notes: notes,
            staffs: staffs,
            activeHistories: activeHistories
        });

    } catch (err) {
        console.error('Lỗi tải chi tiết khách hàng:', err);
        res.status(500).send('Lỗi máy chủ khi tải hồ sơ');
    }
});

// 9. Tab "Đã xóa" (Cập nhật truy vấn lấy thêm thời gian deleted_at)
router.get('/trash', isAdmin, async (req, res) => {
    try {
        const [deletedStaffs] = await db.execute(
            'SELECT id, username, full_name, deleted_at FROM Users WHERE role = "Staff" AND is_deleted = 1 ORDER BY deleted_at DESC'
        );
        const [deletedCustomers] = await db.execute(`
            SELECT c.id, c.full_name, c.phone_1, c.deleted_at, u.full_name as staff_name 
            FROM Customers c 
            LEFT JOIN Users u ON c.staff_id = u.id 
            WHERE c.is_deleted = 1
            ORDER BY c.deleted_at DESC
        `);
        res.render('admin/trash', { deletedStaffs, deletedCustomers });
    } catch (err) {
        res.status(500).send('Lỗi tải dữ liệu thùng rác');
    }
});

// ==========================================
// XỬ LÝ KHÔI PHỤC TỪ THÙNG RÁC
// ==========================================

// 10. Khôi phục Nhân viên
router.post('/staff/restore/:id', isAdmin, async (req, res) => {
    try {
        await db.execute(
            'UPDATE Users SET is_deleted = 0, is_locked = 0, lock_message = NULL, deleted_at = NULL WHERE id = ?',
            [req.params.id]
        );
        await logAction(req.session.userId, req.params.id, 'RESTORE_STAFF', `Khôi phục tài khoản nhân viên từ Thùng rác`);
        res.redirect('/admin/trash');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi khôi phục nhân viên');
    }
});

// 11. Khôi phục Khách hàng
router.post('/customers/restore/:id', isAdmin, async (req, res) => {
    try {
        await db.execute(
            'UPDATE Customers SET is_deleted = 0, deleted_at = NULL WHERE id = ?',
            [req.params.id]
        );
        await logAction(req.session.userId, null, 'RESTORE_CUSTOMER', `Admin khôi phục khách hàng ID: ${req.params.id}`);
        res.redirect('/admin/trash');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi khôi phục khách hàng');
    }
});

// ==========================================
// XỬ LÝ SỬA THÔNG TIN KHÁCH HÀNG (ADMIN)
// ==========================================

// 12. HIỂN THỊ GIAO DIỆN FORM SỬA KHÁCH HÀNG (ĐÂY LÀ ROUTE BẠN BỊ THIẾU)
// GIAO DIỆN SỬA KHÁCH HÀNG (ADMIN)
router.get('/customers/edit/:id', isAdmin, async (req, res) => {
    try {
        const [customer] = await db.execute('SELECT * FROM Customers WHERE id = ?', [req.params.id]);
        if (customer.length === 0) return res.status(404).send('Không tìm thấy khách hàng');

        // Lấy danh sách nhân viên để Admin có thể chuyển đổi người phụ trách
        const [staffs] = await db.execute("SELECT id, full_name FROM Users WHERE role='Staff' AND is_deleted=0");

        res.render('admin/edit-customer', { cust: customer[0], staffs });
    } catch (err) {
        res.status(500).send('Lỗi tải thông tin');
    }
});

// 13. Xử lý LƯU thông tin khách hàng khi Admin bấm Cập nhật
// XỬ LÝ LƯU THÔNG TIN KHÁCH HÀNG (ADMIN)
router.post('/customers/edit/:id', isAdmin, async (req, res) => {
    try {
        const { full_name, phone_1, phone_2, gender, birthday, email, cccd, address_1, address_2, staff_id } = req.body;

        // Bước 1: Lưu vào DB (Đã thành công theo xác nhận của bạn)
        await db.execute(`
            UPDATE Customers SET 
            full_name = ?, phone_1 = ?, phone_2 = ?, gender = ?, birthday = ?, 
            email = ?, cccd = ?, address_1 = ?, address_2 = ?, staff_id = ?
            WHERE id = ?`,
            [
                full_name, phone_1, phone_2 || null, gender || 'Chưa xác định', birthday || null,
                email || null, cccd || null, address_1 || null, address_2 || null,
                staff_id || null, req.params.id
            ]
        );
        await logAction(req.session.userId, null, 'EDIT_CUSTOMER', `Admin sửa thông tin khách hàng: ${full_name}`);

        // Bước 2: TRẢ VỀ JSON (Bắt buộc để AJAX ở frontend không báo lỗi)
        return res.json({ success: true, message: 'Cập nhật thành công' });

    } catch (err) {
        console.error(err);
        // Trả về lỗi định dạng JSON
        return res.status(500).json({ success: false, message: 'Lỗi máy chủ khi lưu' });
    }
});

// ==========================================
// QUẢN LÝ TUYỂN DỤNG (KANBAN ADMIN)
// ==========================================

router.get('/recruitment', isAdmin, recruitmentController.getKanbanBoard);
router.post('/api/recruitment/update-status', isAdmin, recruitmentController.updateCandidateStatus);
router.post('/api/recruitment/approve', isAdmin, recruitmentController.approveCandidate);
router.get('/api/recruitment/load-more', isAdmin, recruitmentController.loadMoreCards);

// ==========================================
// QUẢN LÝ SỰ KIỆN (EVENTS)
// ==========================================

// 1. Hiển thị danh sách Sự kiện
router.get('/events', isAdmin, async (req, res) => {
    try {
        const { status, start_date, end_date } = req.query;
        let sql = 'SELECT * FROM Events WHERE 1=1';
        const params = [];

        if (status === 'upcoming') {
            sql += ' AND start_time > NOW()';
        } else if (status === 'ongoing') {
            sql += ' AND start_time <= NOW() AND end_time >= NOW()';
        } else if (status === 'completed') {
            sql += ' AND end_time < NOW()';
        }

        if (start_date) {
            sql += ' AND start_time >= ?';
            params.push(`${start_date} 00:00:00`);
        }
        if (end_date) {
            sql += ' AND start_time <= ?';
            params.push(`${end_date} 23:59:59`);
        }

        sql += ' ORDER BY start_time DESC';

        const [events] = await db.execute(sql, params);

        // Lấy danh sách nhân viên đang hoạt động để Admin chọn người phụ trách
        const [staffList] = await db.execute('SELECT id, full_name, phone_1 FROM Users WHERE role = "Staff" AND is_deleted = 0');

        // Lấy danh sách nhân viên phụ trách cho từng sự kiện
        for (let ev of events) {
            const [managers] = await db.execute(`
                SELECT u.id, u.full_name, u.phone_1 
                FROM Event_Managers em
                JOIN Users u ON em.user_id = u.id
                WHERE em.event_id = ?
            `, [ev.id]);
            ev.managers = managers; // Gắn mảng người phụ trách vào sự kiện
        }

        res.render('admin/events', { events, staffList, query: req.query });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách sự kiện');
    }
});

// 2. Thêm mới Sự kiện (Đã bổ sung description và drive_link)
router.post('/events/add', isAdmin, async (req, res) => {
    const { event_name, location, start_time, end_time, description, drive_link, manager_ids, kpi_points } = req.body;
    try {
        const [result] = await db.execute(
            'INSERT INTO Events (event_name, location, start_time, end_time, description, drive_link, kpi_points) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [event_name, location, start_time, end_time, description || null, drive_link || null, kpi_points || 0]
        );
        const newEventId = result.insertId;

        if (manager_ids) {
            const ids = Array.isArray(manager_ids) ? manager_ids : [manager_ids];
            for (let uid of ids) {
                await db.execute('INSERT INTO Event_Managers (event_id, user_id) VALUES (?, ?)', [newEventId, uid]);
            }
        }

        await logAction(req.session.userId, null, 'ADD_EVENT', `Tạo sự kiện: ${event_name}`);
        res.redirect('/admin/events');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi khi tạo sự kiện');
    }
});

// 2b. XỬ LÝ SỬA SỰ KIỆN CHƯA DIỄN RA (Tính năng mới)
router.post('/events/edit/:id', isAdmin, async (req, res) => {
    const eventId = req.params.id;
    const { event_name, location, start_time, end_time, description, drive_link, manager_ids, kpi_points } = req.body;

    try {
        // Kiểm tra xem sự kiện đã diễn ra chưa
        const [eventCheck] = await db.execute('SELECT start_time FROM Events WHERE id = ?', [eventId]);
        if (eventCheck.length === 0) return res.status(404).send('Không tìm thấy sự kiện');

        if (new Date(eventCheck[0].start_time) <= new Date()) {
            return res.status(400).send('Sự kiện đã hoặc đang diễn ra, không thể sửa đổi!');
        }

        // Cập nhật thông tin cơ bản
        await db.execute(
            'UPDATE Events SET event_name=?, location=?, start_time=?, end_time=?, description=?, drive_link=?, kpi_points=? WHERE id=?',
            [event_name, location, start_time, end_time, description || null, drive_link || null, kpi_points || 0, eventId]
        );

        // Cập nhật người phụ trách (Xóa cũ, Thêm mới)
        await db.execute('DELETE FROM Event_Managers WHERE event_id = ?', [eventId]);
        if (manager_ids) {
            const ids = Array.isArray(manager_ids) ? manager_ids : [manager_ids];
            for (let uid of ids) {
                await db.execute('INSERT INTO Event_Managers (event_id, user_id) VALUES (?, ?)', [eventId, uid]);
            }
        }

        await logAction(req.session.userId, null, 'EDIT_EVENT', `Sửa thông tin sự kiện ID: ${eventId}`);
        res.redirect('/admin/events');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi khi cập nhật sự kiện');
    }
});

// 1b. Mở màn hình hiển thị QR Code động (Dành cho iPad/Lễ tân)
router.get('/events/:id/qr-display', isAdmin, async (req, res) => {
    try {
        const [events] = await db.execute('SELECT id, event_name FROM Events WHERE id = ?', [req.params.id]);
        if (events.length === 0) return res.status(404).send('Không tìm thấy sự kiện');
        res.render('admin/qr-display', { event: events[0] });
    } catch (err) {
        res.status(500).send('Lỗi hệ thống');
    }
});

// 1c. API Cấp mới Token QR mỗi 30 giây (AJAX)
router.post('/events/:id/refresh-qr', isAdmin, async (req, res) => {
    try {
        // Tạo chuỗi mã hóa ngẫu nhiên 16 ký tự
        const newToken = crypto.randomBytes(8).toString('hex');
        // Thời gian sống của mã: 45 giây tính từ hiện tại (Cho phép trễ 15s)
        const validTo = new Date(Date.now() + 45000);

        await db.execute(
            'UPDATE Events SET qr_token = ?, qr_valid_to = ? WHERE id = ?',
            [newToken, validTo, req.params.id]
        );

        // Tạo link URL Check-in hoàn chỉnh để gửi cho Frontend vẽ mã
        const domain = req.protocol + '://' + req.get('host');
        const checkinUrl = `${domain}/checkin/${req.params.id}?token=${newToken}`;

        res.json({ success: true, url: checkinUrl });
    } catch (err) {
        res.json({ success: false });
    }
});

// Xem chi tiết sự kiện và danh sách khách mời (Admin)
router.get('/events/detail/:id', isAdmin, async (req, res) => {
    try {
        const eventId = req.params.id;
        const [events] = await db.execute('SELECT * FROM Events WHERE id = ?', [eventId]);
        if (events.length === 0) return res.status(404).send('Không tìm thấy sự kiện');

        // Lấy danh sách toàn bộ khách mời của sự kiện này
        const [participants] = await db.execute(`
            SELECT ep.*, c.full_name, c.phone_1, u.full_name as staff_name 
            FROM Event_Participants ep 
            JOIN Customers c ON ep.customer_id = c.id
            LEFT JOIN Users u ON c.staff_id = u.id 
            WHERE ep.event_id = ?`, [eventId]);

        res.render('admin/event-detail', { event: events[0], participants });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải chi tiết sự kiện');
    }
});

// Xem báo cáo thống kê Sự kiện
router.get('/events/stats/:id', isAdmin, async (req, res) => {
    try {
        const eventId = req.params.id;

        // 1. Lấy thông tin cơ bản của sự kiện
        const [events] = await db.execute('SELECT * FROM Events WHERE id = ?', [eventId]);
        if (events.length === 0) return res.status(404).send('Không tìm thấy sự kiện');

        // 2. Lấy toàn bộ danh sách khách mời của sự kiện này để tính toán
        const [participants] = await db.execute(`
            SELECT status 
            FROM Event_Participants 
            WHERE event_id = ?
        `, [eventId]);

        // 3. TÍNH TOÁN THỐNG KÊ TỔNG QUAN (BIẾN STATS BỊ THIẾU)
        const stats = {
            total: participants.length,
            attended: participants.filter(p => p.status === 'Đã tham dự').length,
            not_attended: participants.filter(p => p.status === 'Không tham dự' || p.status === 'Từ chối tham gia').length,
            pending: participants.filter(p => p.status === 'Đã mời' || p.status === 'Đã nhận lời mời' || p.status === 'Cần suy nghĩ thêm' || !p.status).length
        };

        // 4. THỐNG KÊ HIỆU SUẤT THEO NHÂN VIÊN (BIẾN STAFF_STATS)
        const [staff_stats] = await db.execute(`
            SELECT u.full_name as staff_name, COUNT(ep.customer_id) as customer_count
            FROM Event_Participants ep
            JOIN Customers c ON ep.customer_id = c.id
            LEFT JOIN Users u ON c.staff_id = u.id
            WHERE ep.event_id = ?
            GROUP BY c.staff_id, u.full_name
            ORDER BY customer_count DESC
        `, [eventId]);

        // Xử lý trường hợp khách hàng do Admin tạo (không thuộc Staff nào)
        staff_stats.forEach(stat => {
            if (!stat.staff_name) stat.staff_name = 'Quản trị viên (Hệ thống)';
        });

        // 5. Render ra giao diện và truyền đầy đủ biến
        res.render('admin/event-stats', {
            event: events[0],
            stats: stats,           // Đã bổ sung
            staff_stats: staff_stats // Đã bổ sung
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải báo cáo sự kiện');
    }
});

// 3. Xóa Sự kiện
router.post('/events/delete/:id', isAdmin, async (req, res) => {
    const eventId = req.params.id;
    try {
        // Do đã cấu hình ON DELETE CASCADE trong SQL, khi xóa Event thì dữ liệu trong Event_Managers tự động bị xóa theo
        await db.execute('DELETE FROM Events WHERE id = ?', [eventId]);
        await logAction(req.session.userId, null, 'DELETE_EVENT', `Đã xóa sự kiện ID: ${eventId}`);
        res.redirect('/admin/events');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi khi xóa sự kiện');
    }
});
// ==========================================
// QUẢN LÝ TÀI LIỆU NỘI BỘ (DOCUMENTS)
// ==========================================

// 1. Xem danh sách tài liệu
router.get('/documents', isAdmin, async (req, res) => {
    try {
        const [documents] = await db.execute('SELECT * FROM Documents ORDER BY created_at DESC');
        res.render('admin/documents', { documents });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách tài liệu');
    }
});

// 2. Thêm tài liệu mới
router.post('/documents/add', isAdmin, async (req, res) => {
    const { title, description, file_link, document_type } = req.body;
    try {
        await db.execute(
            'INSERT INTO Documents (title, description, file_link, document_type, is_visible) VALUES (?, ?, ?, ?, 1)',
            [title, description || null, file_link, document_type || null]
        );
        await logAction(req.session.userId, null, 'ADD_DOCUMENT', `Thêm tài liệu mới: ${title}`);
        res.redirect('/admin/documents');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi thêm tài liệu');
    }
});

// 3. Sửa thông tin tài liệu
router.post('/documents/edit/:id', isAdmin, async (req, res) => {
    const { title, description, file_link, document_type } = req.body;
    try {
        await db.execute(
            'UPDATE Documents SET title = ?, description = ?, file_link = ?, document_type = ? WHERE id = ?',
            [title, description || null, file_link, document_type || null, req.params.id]
        );
        await logAction(req.session.userId, null, 'EDIT_DOCUMENT', `Sửa tài liệu ID: ${req.params.id}`);
        res.redirect('/admin/documents');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi sửa tài liệu');
    }
});

// 5. Bật/Tắt hiển thị tài liệu
router.post('/documents/toggle/:id', isAdmin, async (req, res) => {
    try {
        // Đảo ngược trạng thái is_visible (nếu đang null thì coi như là 1 -> ẩn thành 0)
        await db.execute('UPDATE Documents SET is_visible = IF(COALESCE(is_visible, 1) = 1, 0, 1) WHERE id = ?', [req.params.id]);
        res.redirect('/admin/documents');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi cập nhật trạng thái tài liệu');
    }
});

// 4. Xóa tài liệu
router.post('/documents/delete/:id', isAdmin, async (req, res) => {
    try {
        await db.execute('DELETE FROM Documents WHERE id = ?', [req.params.id]);
        await logAction(req.session.userId, null, 'DELETE_DOCUMENT', `Xóa tài liệu ID: ${req.params.id}`);
        res.redirect('/admin/documents');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi xóa tài liệu');
    }
});
// ==========================================
// QUẢN LÝ THÔNG BÁO (NOTIFICATIONS)
// ==========================================

// 1. Xem danh sách thông báo
router.get('/notifications', isAdmin, async (req, res) => {
    try {
        const { status, start_date, end_date } = req.query;
        let sql = `
            SELECT n.*, u.full_name as creator_name
            FROM Notifications n
            LEFT JOIN Users u ON n.created_by = u.id
            WHERE 1=1
        `;
        const params = [];

        if (status === 'upcoming') {
            sql += ' AND n.start_time > NOW()';
        } else if (status === 'ongoing') {
            sql += ' AND n.start_time <= NOW() AND n.end_time >= NOW()';
        } else if (status === 'completed') {
            sql += ' AND n.end_time < NOW()';
        }

        if (start_date) {
            sql += ' AND n.start_time >= ?';
            params.push(`${start_date} 00:00:00`);
        }
        if (end_date) {
            sql += ' AND n.start_time <= ?';
            params.push(`${end_date} 23:59:59`);
        }

        sql += ' ORDER BY n.created_at DESC';

        const [notifications] = await db.execute(sql, params);
        res.render('admin/notifications', { notifications, now: new Date(), query: req.query });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách thông báo');
    }
});

// Xem báo cáo lượt đọc thông báo
router.get('/notifications/:id/reads', isAdmin, async (req, res) => {
    try {
        const notiId = req.params.id;

        // 1. Lấy thông tin chi tiết của thông báo
        const [notis] = await db.execute('SELECT * FROM Notifications WHERE id = ?', [notiId]);
        if (notis.length === 0) return res.status(404).send('Không tìm thấy thông báo');

        // 2. Lấy danh sách nhân sự (Staff) và trạng thái xem thông báo này
        const [reads] = await db.execute(`
            SELECT u.id, u.full_name, u.username, u.business_code, u.work_area, u.phone_1,
                   IF(nr.user_id IS NOT NULL, 1, 0) as is_read
            FROM Users u
            LEFT JOIN Notification_Reads nr ON u.id = nr.user_id AND nr.notification_id = ?
            WHERE u.role = 'Staff' AND u.is_deleted = 0
            ORDER BY is_read DESC, u.full_name ASC
        `, [notiId]);

        // 3. TÍNH TOÁN THỐNG KÊ
        const total = reads.length;
        const read_count = reads.filter(r => r.is_read == 1).length;
        const unread_count = total - read_count;

        const stats = {
            total: total,
            read_count: read_count,
            unread_count: unread_count
        };

        // 4. Truyền toàn bộ dữ liệu ra View
        res.render('admin/notification-reads', {
            noti: notis[0],
            reads: reads,
            stats: stats
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi hệ thống khi tải lượt đọc');
    }
});

// 2. Thêm thông báo mới
router.post('/notifications/add', isAdmin, async (req, res) => {
    const { title, content, drive_link, start_time, end_time } = req.body;
    try {
        await db.execute(
            'INSERT INTO Notifications (title, content, drive_link, start_time, end_time, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [title, content, drive_link || null, start_time, end_time, req.session.userId]
        );

        // ---> THÊM DÒNG NÀY ĐỂ BẮN TÍN HIỆU REAL-TIME <---
        if (global.sendRealtimeNotification) global.sendRealtimeNotification();

        await logAction(req.session.userId, null, 'ADD_NOTIFICATION', `Tạo thông báo: ${title}`);
        res.redirect('/admin/notifications');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi thêm thông báo');
    }
});

// 3. Sửa thông báo (Kèm ghi log lịch sử theo yêu cầu)
router.post('/notifications/edit/:id', isAdmin, async (req, res) => {
    const { title, content, drive_link, start_time, end_time } = req.body;
    try {
        await db.execute(
            'UPDATE Notifications SET title = ?, content = ?, drive_link = ?, start_time = ?, end_time = ? WHERE id = ?',
            [title, content, drive_link || null, start_time, end_time, req.params.id]
        );
        // Lưu lịch sử sửa đổi (Chỉ Admin thấy trong tab Nhân sự/Lịch sử thao tác)
        await logAction(req.session.userId, null, 'EDIT_NOTIFICATION', `Cập nhật thông báo ID ${req.params.id}: ${title}`);
        res.redirect('/admin/notifications');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi sửa thông báo');
    }
});

// 4. Xóa thông báo
router.post('/notifications/delete/:id', isAdmin, async (req, res) => {
    try {
        // Xóa thông báo (Các lượt đọc trong Notification_Reads cũng nên được tự động dọn dẹp nếu DB thiết lập khóa ngoại ON DELETE CASCADE)
        await db.execute('DELETE FROM Notifications WHERE id = ?', [req.params.id]);
        await logAction(req.session.userId, null, 'DELETE_NOTIFICATION', `Xóa thông báo ID: ${req.params.id}`);
        res.redirect('/admin/notifications');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi xóa thông báo');
    }
});

// ==========================================
// QUẢN LÝ BIỂU MẪU KHẢO SÁT (SURVEY FORMS)
// ==========================================

// 1. Danh sách biểu mẫu
router.get('/forms', isAdmin, async (req, res) => {
    try {
        const [forms] = await db.execute(`
            SELECT st.*, u.full_name as creator_name 
            FROM Survey_Templates st 
            LEFT JOIN Users u ON st.created_by = u.id 
            WHERE st.is_deleted = 0
            ORDER BY st.created_at DESC
        `);
        res.render('admin/forms', { forms });
    } catch (err) {
        res.status(500).send('Lỗi tải danh sách biểu mẫu');
    }
});

// 2. Giao diện tạo mới / sửa biểu mẫu
router.get('/forms/builder', isAdmin, async (req, res) => {
    const { id } = req.query;
    let form = null;
    if (id) {
        const [forms] = await db.execute('SELECT * FROM Survey_Templates WHERE id = ?', [id]);
        if (forms.length > 0) form = forms[0];
    }
    res.render('admin/form-builder', { form });
});

// 3. Xử lý Lưu biểu mẫu (Tạo mới hoặc Cập nhật)
router.post('/forms/save', isAdmin, async (req, res) => {
    const { id, title, description, form_structure } = req.body;
    try {
        if (id) {
            await db.execute(
                'UPDATE Survey_Templates SET title = ?, description = ?, form_structure = ? WHERE id = ?',
                [title, description, form_structure, id]
            );
            await logAction(req.session.userId, null, 'EDIT_FORM', `Sửa biểu mẫu: ${title}`);
        } else {
            await db.execute(
                'INSERT INTO Survey_Templates (title, description, form_structure, created_by) VALUES (?, ?, ?, ?)',
                [title, description, form_structure, req.session.userId]
            );
            await logAction(req.session.userId, null, 'ADD_FORM', `Tạo biểu mẫu mới: ${title}`);
        }
        res.redirect('/admin/forms');
    } catch (err) {
        res.status(500).send('Lỗi lưu biểu mẫu');
    }
});

// 4. Khóa / Mở khóa biểu mẫu
router.post('/forms/toggle/:id', isAdmin, async (req, res) => {
    try {
        await db.execute('UPDATE Survey_Templates SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
        res.redirect('/admin/forms');
    } catch (err) {
        res.status(500).send('Lỗi cập nhật trạng thái biểu mẫu');
    }
});

// 5. Xóa mềm biểu mẫu
router.post('/forms/delete/:id', isAdmin, async (req, res) => {
    try {
        await db.execute('UPDATE Survey_Templates SET is_deleted = 1, is_active = 0 WHERE id = ?', [req.params.id]);
        res.redirect('/admin/forms');
    } catch (err) {
        res.status(500).send('Lỗi xóa biểu mẫu');
    }
});

// ==========================================
// QUẢN LÝ CẤU HÌNH HỆ THỐNG & HÌNH ẢNH
// ==========================================

// 1. Xem trang cài đặt hệ thống
router.get('/settings', isAdmin, async (req, res) => {
    res.render('admin/settings');
});

// 2. Xử lý Upload Logo và Banner
router.post('/settings/update-media', isAdmin, (req, res) => {
    upload.fields([
        { name: 'logo', maxCount: 1 },
        { name: 'banner', maxCount: 1 }
    ])(req, res, async (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.send('<script>alert("🛑 Kích thước ảnh tối đa là 5MB!"); window.history.back();</script>');
            return res.send(`<script>alert("🛑 Lỗi tải ảnh: ${err.message}"); window.history.back();</script>`);
        }
        try {
            if (req.files['logo']) {
                const url = await processSystemImage(req.files['logo'][0].buffer, 'system_logo');
                await db.execute('UPDATE System_Configs SET config_value = ? WHERE config_key = "system_logo"', [url]);
                req.app.locals.system_logo = url; // Cập nhật ngay lên RAM
            }
            if (req.files['banner']) {
                const url = await processSystemImage(req.files['banner'][0].buffer, 'dashboard_banner');
                await db.execute('UPDATE System_Configs SET config_value = ? WHERE config_key = "dashboard_banner"', [url]);
                req.app.locals.dashboard_banner = url; // Cập nhật ngay lên RAM
            }
            await logAction(req.session.userId, null, 'UPDATE_SETTINGS', 'Cập nhật nhận diện thương hiệu');
            res.redirect('/admin/settings');
        } catch (error) {
            console.error(error);
            res.send('<script>alert("🛑 Lỗi xử lý hình ảnh!"); window.history.back();</script>');
        }
    });
});

// 3. Xử lý Cập nhật Avatar Nhân viên
router.post('/staff/update-avatar/:id', isAdmin, (req, res) => {
    upload.single('avatar')(req, res, async (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.send('<script>alert("🛑 Kích thước ảnh tối đa là 5MB!"); window.history.back();</script>');
            return res.send(`<script>alert("🛑 Lỗi tải ảnh: ${err.message}"); window.history.back();</script>`);
        }

        try {
            if (!req.file) return res.send('<script>alert("Bạn chưa chọn ảnh nào!"); window.history.back();</script>');

            const staffId = req.params.id;
            const fileName = `avatar-${staffId}-${Date.now()}.webp`;
            const uploadDir = path.join(__dirname, '../public/uploads/avatars');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

            // Xử lý nén và cắt ảnh vuông 200x200
            await sharp(req.file.buffer)
                .resize(200, 200, { fit: 'cover' })
                .webp({ quality: 80 })
                .toFile(path.join(uploadDir, fileName));

            const avatarUrl = `/uploads/avatars/${fileName}`;

            await db.execute('UPDATE Users SET avatar_url = ? WHERE id = ?', [avatarUrl, staffId]);
            await logAction(req.session.userId, staffId, 'UPDATE_AVATAR', 'Cập nhật ảnh đại diện nhân viên');

            // Thay vì redirect('back'), ta chỉ định thẳng về trang hồ sơ của nhân viên đó
            res.redirect('/admin/staff/detail/' + staffId);
        } catch (error) {
            console.error(error);
            res.send('<script>alert("🛑 Lỗi xử lý ảnh!"); window.history.back();</script>');
        }
    });
});
// 4. Cập nhật quyền cho phép nhân viên sửa giao diện
router.post('/settings/toggle-staff-layout', isAdmin, async (req, res) => {
    try {
        const val = req.body.allow_staff_edit_layout === '1' ? '1' : '0';
        
        // Cập nhật Database
        await db.execute('UPDATE System_Configs SET config_value = ? WHERE config_key = "allow_staff_edit_layout"', [val]);

        // Cập nhật lên biến toàn cục RAM (để các file EJS nhận diện ngay lập tức)
        req.app.locals.allow_staff_edit_layout = val;
        await logAction(req.session.userId, null, 'UPDATE_SETTINGS', `Cập nhật quyền Staff - Sửa UI: ${val}`);
        res.redirect('/admin/settings');
    } catch (error) {
        console.error(error);
        res.send('<script>alert("🛑 Lỗi cập nhật cấu hình!"); window.history.back();</script>');
    }
});

// ==========================================
// API DỮ LIỆU BIỂU ĐỒ (DASHBOARD ANALYTICS)
// ==========================================
router.get('/api/dashboard-charts', isAdmin, async (req, res) => {
    try {
        const year = req.query.year || new Date().getFullYear();

        // 1. Biểu đồ Cột: Khách hàng mới theo 12 tháng
        const [customerStats] = await db.execute(`
            SELECT MONTH(created_at) as month, COUNT(*) as count 
            FROM Customers 
            WHERE YEAR(created_at) = ? AND is_deleted = 0 
            GROUP BY MONTH(created_at)
        `, [year]);

        let customerData = Array(12).fill(0);
        customerStats.forEach(stat => {
            customerData[stat.month - 1] = stat.count;
        });

        // 2. Biểu đồ Tròn: Tỷ lệ khách hàng theo Tag
        const [tagStats] = await db.execute(`
            SELECT t.tag_name, t.color_code, COUNT(ct.customer_id) as count 
            FROM Tags t 
            LEFT JOIN Customer_Tags ct ON t.id = ct.tag_id 
            LEFT JOIN Customers c ON ct.customer_id = c.id AND c.is_deleted = 0
            GROUP BY t.id, t.tag_name, t.color_code
            HAVING count > 0
        `);

        // 3. Biểu đồ Đường: Tỷ lệ chuyển đổi Sự kiện (Đã mời vs Đã đến)
        const [eventStats] = await db.execute(`
            SELECT MONTH(e.start_time) as month, 
                   COUNT(ep.customer_id) as total_invited, 
                   SUM(CASE WHEN ep.status = 'Đã tham dự' THEN 1 ELSE 0 END) as total_attended 
            FROM Events e 
            JOIN Event_Participants ep ON e.id = ep.event_id 
            WHERE YEAR(e.start_time) = ?
            GROUP BY MONTH(e.start_time)
        `, [year]);

        let invitedData = Array(12).fill(0);
        let attendedData = Array(12).fill(0);
        eventStats.forEach(stat => {
            invitedData[stat.month - 1] = stat.total_invited;
            attendedData[stat.month - 1] = stat.total_attended;
        });

        // Trả về JSON tổng hợp
        res.json({
            success: true,
            chartCustomer: customerData,
            chartTags: {
                labels: tagStats.map(t => t.tag_name),
                data: tagStats.map(t => t.count),
                colors: tagStats.map(t => t.color_code)
            },
            chartEvent: { invited: invitedData, attended: attendedData }
        });

    } catch (err) {
        console.error("Lỗi API Chart:", err);
        res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
});

// ==========================================
// QUẢN TRỊ KPI & BẢNG XẾP HẠNG
// ==========================================

// 1. Mở trang Cấu hình KPI (Admin)
router.get('/kpi-settings', isAdmin, kpiController.getIndex);

// 2. Lưu cấu hình KPI mới
router.post('/kpi-settings/create', isAdmin, kpiController.createProgram);

// 3. Cập nhật cấu hình KPI
router.post('/kpi-settings/edit/:id', isAdmin, kpiController.updateProgram);

// 4. Đồng bộ / Tính lại điểm KPI
router.post('/kpi-settings/:id/recalculate', isAdmin, kpiController.recalculateKpi);

// 5. Xóa cấu hình KPI
router.post('/kpi-settings/delete/:id', isAdmin, kpiController.deleteProgram);

// 3. Mở Bảng xếp hạng vinh danh
router.get('/leaderboard', isAdmin, async (req, res) => {
    try {
        const month = req.query.month || new Date().getMonth() + 1;
        const year = req.query.year || new Date().getFullYear();

        const data = await calculateLeaderboard(month, year);
        res.render('admin/leaderboard', {
            month, year,
            config: data.config,
            leaderboard: data.leaderboard,
            userRole: 'Admin'
        });
    } catch (err) {
        res.status(500).send('Lỗi tải Bảng xếp hạng');
    }
});

// ==========================================
// API LƯU GIAO DIỆN DASHBOARD (GRIDSTACK)
// ==========================================
router.post('/dashboard/save-layout', isAdmin, async (req, res) => {
    try {
        const myId = req.session.userId;

        // Lấy dữ liệu layout được gửi lên (Hỗ trợ biến 'desktop_layout' hoặc 'layout' cũ)
        const desktopData = req.body.desktop_layout || req.body.layout;
        const mobileData = req.body.mobile_layout;

        let sql = 'UPDATE Users SET ';
        let params = [];
        let updateCols = [];

        // Chỉ cập nhật những trường có dữ liệu gửi lên
        if (desktopData) {
            updateCols.push('dashboard_layout = ?');
            params.push(JSON.stringify(desktopData));
        }
        if (mobileData) {
            updateCols.push('mobile_layout = ?');
            params.push(JSON.stringify(mobileData));
        }

        if (updateCols.length > 0) {
            sql += updateCols.join(', ') + ' WHERE id = ?';
            params.push(myId);
            await db.execute(sql, params);
        }

        res.json({ success: true, message: 'Đã lưu giao diện!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Lỗi lưu giao diện' });
    }
});

// API Xóa cấu hình Dashboard của Admin
router.post('/dashboard/reset-layout', isAdmin, async (req, res) => {
    try {
        const userId = req.session.userId; 
        // Xóa sạch cả 2 layout về NULL
        await db.execute('UPDATE Users SET dashboard_layout = NULL, mobile_layout = NULL WHERE id = ?', [userId]);
        res.json({ success: true, message: 'Đã khôi phục giao diện' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
});


// ==========================================
// // Xử lý cập nhật thông tin Tag
// ==========================================
// 1. API Xử lý CẬP NHẬT Tag (Dành cho nút Sửa)
router.post('/tags/edit/:id', isAdmin, async (req, res) => {
    try {
        const { tag_name, color_code } = req.body;
        const tagId = req.params.id;

        await db.execute(
            'UPDATE Tags SET tag_name = ?, color_code = ? WHERE id = ?',
            [tag_name.trim(), color_code, tagId]
        );

        res.redirect('/admin/tags'); // Quay lại trang danh sách sau khi lưu
    } catch (err) {
        console.error('Lỗi sửa tag:', err);
        res.status(500).send('Lỗi máy chủ khi cập nhật Tag');
    }
});

// 2. API Xử lý XÓA Tag (Dành cho nút Xóa)
router.post('/tags/delete/:id', isAdmin, async (req, res) => {
    try {
        const tagId = req.params.id;

        // Trước khi xóa Tag, hệ thống sẽ tự động gỡ Tag này khỏi tất cả khách hàng
        await db.execute('DELETE FROM Customer_Tags WHERE tag_id = ?', [tagId]);

        // Sau đó mới xóa Tag trong từ điển
        await db.execute('DELETE FROM Tags WHERE id = ?', [tagId]);

        res.redirect('/admin/tags');
    } catch (err) {
        console.error('Lỗi xóa tag:', err);
        res.status(500).send('Lỗi máy chủ khi xóa Tag');
    }
});

// Route gọi API thu hồi Active (Soft Delete & Trừ điểm Hồi tố)
router.post('/customers/active/:active_id/delete', isAdmin, customerController.deleteActiveCustomer);

// Route gọi API thêm mới Active cho Admin
router.post('/customers/:id/active', isAdmin, (req, res, next) => {
    req.user = { username: req.session.username || 'Admin' }; // Gắn tên Admin thực hiện
    next();
}, customerController.addActiveCustomer);

router.get('/api/kpi/history', isAdmin, kpiController.getKpiHistoryAPI);

// [ROUTER BÁO CÁO KPI DÀNH CHO ADMIN]
router.get('/kpi-report', isAdmin, kpiController.renderKpiReportPage);
router.get('/api/kpi/all-logs', isAdmin, kpiController.getAdminKpiLogsAPI);

module.exports = router;