const express = require('express');
const router = express.Router();
const db = require('../config/db');

const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx'); // Thêm dòng này ở đầu file, cạnh các thư viện khác

// Cấu hình Multer cho Staff (Giới hạn 2MB để chống up file quá nặng)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Chỉ chấp nhận file ảnh!'));
    }
});

// Middleware kiểm tra quyền Staff
const isStaff = (req, res, next) => {
    if (req.session && req.session.role === 'Staff') return next();
    res.redirect('/auth/login');
};

// ==========================================
// MENU VÀ CÁC TAB CHỨC NĂNG (STAFF)
// ==========================================

// 1. Trang Menu chính (Dashboard các Tab chức năng)
router.get('/', isStaff, async (req, res) => {
    // Đếm số lượng thông báo chưa đọc
    const [unread] = await db.execute(`
        SELECT COUNT(*) as c FROM Notifications n
        WHERE n.start_time <= NOW() AND n.end_time >= NOW()
        AND n.id NOT IN (SELECT notification_id FROM Notification_Reads WHERE user_id = ?)
    `, [req.session.userId]);
    
    // Lấy thông tin họ tên từ bảng Users
    const [users] = await db.execute('SELECT full_name, avatar_url, dashboard_layout FROM Users WHERE id = ?', [req.session.userId]);
    const full_name = users.length > 0 ? users[0].full_name : req.session.username;
    const avatar_url = users.length > 0 ? users[0].avatar_url : null;
    const dashboard_layout = users.length > 0 && users[0].dashboard_layout ? users[0].dashboard_layout : '[]';
    
    res.render('staff/menu', { full_name, avatar_url, unreadCount: unread[0].c, dashboard_layout });
});

// 2. Tab Thông tin cá nhân
router.get('/profile', isStaff, async (req, res) => {
    try {
        const [staff] = await db.execute('SELECT * FROM Users WHERE id = ?', [req.session.userId]);
        res.render('staff/profile', { staff: staff[0] });
    } catch (err) {
        res.status(500).send('Lỗi tải thông tin cá nhân');
    }
});

// Xử lý Nhân viên tự cập nhật ảnh đại diện cá nhân (Đã chống Crash)
router.post('/profile/update-avatar', isStaff, (req, res) => {
    
    // Đưa Multer vào trong để bắt lỗi trực tiếp
    upload.single('avatar')(req, res, async (err) => {
        // BẮT LỖI TỪ MULTER (Ảnh quá lớn, sai định dạng...)
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.send('<script>alert("🛑 Thất bại: Ảnh vượt quá dung lượng cho phép (Tối đa 2MB)!"); window.history.back();</script>');
            }
            return res.send(`<script>alert("🛑 Lỗi tải ảnh: ${err.message}"); window.history.back();</script>`);
        }

        try {
            if (!req.file) return res.send('<script>alert("Vui lòng chọn ảnh!"); window.history.back();</script>');

            const myId = req.session.userId;
            const fileName = `avatar-${myId}-${Date.now()}.webp`;
            const uploadDir = path.join(__dirname, '../public/uploads/avatars');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

            // Nén và cắt ảnh vuông
            await sharp(req.file.buffer)
                .resize(200, 200, { fit: 'cover' })
                .webp({ quality: 80 })
                .toFile(path.join(uploadDir, fileName));

            const avatarUrl = `/uploads/avatars/${fileName}`;
            await db.execute('UPDATE Users SET avatar_url = ? WHERE id = ?', [avatarUrl, myId]);

            res.redirect('/staff/profile');
        } catch (error) {
            console.error(error);
            res.send('<script>alert("🛑 Lỗi hệ thống khi xử lý ảnh. Vui lòng thử lại!"); window.history.back();</script>');
        }
    });
});

// 2b. API Đổi mật khẩu
router.post('/profile/change-password', isStaff, async (req, res) => {
    const { old_password, new_password, confirm_password } = req.body;
    
    if (new_password !== confirm_password) {
        return res.send('<script>alert("Mật khẩu xác nhận không khớp!"); window.history.back();</script>');
    }

    try {
        const [users] = await db.execute('SELECT password FROM Users WHERE id = ?', [req.session.userId]);
        if (users.length === 0 || users[0].password !== old_password) {
            return res.send('<script>alert("Mật khẩu cũ không chính xác!"); window.history.back();</script>');
        }

        await db.execute('UPDATE Users SET password = ? WHERE id = ?', [new_password, req.session.userId]);
        res.send('<script>alert("Đổi mật khẩu thành công!"); window.location.href="/staff/profile";</script>');
    } catch (err) {
        res.status(500).send('Lỗi đổi mật khẩu');
    }
});

// 1. Danh sách khách hàng kèm Tag & Tính năng Tìm kiếm (Debounce)
router.get('/customers', isStaff, async (req, res) => {
    // Lấy từ khóa từ thanh địa chỉ (nếu có)
    const keyword = req.query.q || ''; 
    
    try {
        let sql = `
            SELECT c.id, c.full_name, c.gender, c.phone_1, c.created_at,
            GROUP_CONCAT(t.tag_name SEPARATOR ',') as tag_names,
            GROUP_CONCAT(t.color_code SEPARATOR ',') as tag_colors
            FROM Customers c
            LEFT JOIN Customer_Tags ct ON c.id = ct.customer_id
            LEFT JOIN Tags t ON ct.tag_id = t.id
            WHERE c.staff_id = ? AND c.is_deleted = 0
        `;
        const params = [req.session.userId];

        // Nếu có nhập từ khóa, thêm điều kiện lọc bằng LIKE
        if (keyword) {
            sql += ` AND (c.full_name LIKE ? OR c.phone_1 LIKE ?)`;
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        sql += ` GROUP BY c.id ORDER BY c.created_at DESC`;

        const [customers] = await db.execute(sql, params);
        
        // Truyền thêm biến keyword ra giao diện để giữ lại chữ đã gõ
        res.render('staff/customers', { customers, keyword }); 
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách khách hàng');
    }
});

// 2. Giao diện Form Khảo sát mới (Cho phép chọn biểu mẫu)
router.get('/survey', isStaff, async (req, res) => {
    const templateId = req.query.template_id;
    try {
        // Lấy danh sách các biểu mẫu đang hoạt động
        const [templates] = await db.execute('SELECT id, title, description FROM Survey_Templates WHERE is_active = 1 AND is_deleted = 0 ORDER BY created_at DESC');
        
        let selectedTemplate = null;
        if (templateId) {
            const [temp] = await db.execute('SELECT * FROM Survey_Templates WHERE id = ? AND is_active = 1 AND is_deleted = 0', [templateId]);
            if (temp.length > 0) selectedTemplate = temp[0];
        }

        res.render('staff/survey', { templates, selectedTemplate });
    } catch (err) {
        res.status(500).send('Lỗi tải dữ liệu khảo sát');
    }
});

// 3. Xử lý lưu Khảo sát & Khách hàng (Cập nhật lưu template_id)
router.post('/survey', isStaff, async (req, res) => {
    const { template_id, full_name, gender, phone_1, phone_2, birthday, cccd, address_1, address_2, email, answers } = req.body;
    try {
        const [custResult] = await db.execute(
            `INSERT INTO Customers (staff_id, full_name, gender, phone_1, phone_2, birthday, cccd, address_1, address_2, email) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.userId, full_name, gender || 'Chưa xác định', phone_1, phone_2 || null, birthday || null, cccd || null, address_1 || null, address_2 || null, email || null]
        );

        await db.execute(
            'INSERT INTO Surveys (customer_id, template_id, question_data) VALUES (?, ?, ?)',
            [custResult.insertId, template_id || null, JSON.stringify(answers)]
        );
        res.redirect('/staff/customers');
    } catch (err) {
        res.status(500).send('Lỗi lưu thông tin khảo sát');
    }
});

// 4. BỔ SUNG: Giao diện chọn Tag cho khách hàng
router.get('/customers/:id/tags', isStaff, async (req, res) => {
    const customerId = req.params.id;
    try {
        const [allTags] = await db.execute('SELECT * FROM Tags');
        const [currentTags] = await db.execute(
            'SELECT tag_id FROM Customer_Tags WHERE customer_id = ?',
            [customerId]
        );
        const currentTagIds = currentTags.map(t => t.tag_id);
        
        res.render('staff/manage-tags', { customerId, allTags, currentTagIds });
    } catch (err) {
        res.status(500).send('Lỗi tải dữ liệu Tag');
    }
});

// 5. BỔ SUNG: Xử lý cập nhật Multi-tagging
router.post('/customers/:id/tags', isStaff, async (req, res) => {
    const customerId = req.params.id;
    let selectedTags = req.body.tags || []; 
    if (!Array.isArray(selectedTags)) selectedTags = [selectedTags];

    try {
        await db.execute('DELETE FROM Customer_Tags WHERE customer_id = ?', [customerId]);
        if (selectedTags.length > 0) {
            const values = selectedTags.map(tagId => [customerId, tagId]);
            await db.query('INSERT INTO Customer_Tags (customer_id, tag_id) VALUES ?', [values]);
        }
        res.redirect('/staff/customers');
    } catch (err) {
        res.status(500).send('Lỗi cập nhật Tag');
    }
});
// 6. Giao diện chọn sự kiện cho khách hàng & Xem lịch sử tham gia
router.get('/customers/:id/invite', isStaff, async (req, res) => {
    const customerId = req.params.id;
    try {
        // Lấy thông tin khách hàng
        const [customer] = await db.execute('SELECT full_name, phone_1 FROM Customers WHERE id = ?', [customerId]);
        if (customer.length === 0) return res.status(404).send('Không tìm thấy khách hàng');

        // Lấy các sự kiện SẮP TỚI để mời
        const [events] = await db.execute('SELECT id, event_name FROM Events WHERE start_time >= NOW() ORDER BY start_time ASC');
        
        // LẤY LỊCH SỬ CÁC SỰ KIỆN ĐÃ ĐƯỢC MỜI CỦA KHÁCH NÀY
        const [invitedEvents] = await db.execute(`
            SELECT ep.status, ep.notes, e.id as event_id, e.event_name, e.start_time 
            FROM Event_Participants ep
            JOIN Events e ON ep.event_id = e.id
            WHERE ep.customer_id = ?
            ORDER BY e.start_time DESC
        `, [customerId]);

        res.render('staff/invite', { 
            customerId, 
            customer: customer[0], 
            events,
            invitedEvents 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách sự kiện');
    }
});

// 7. Xử lý lưu lời mời tham gia sự kiện mới
router.post('/customers/:id/invite', isStaff, async (req, res) => {
    const customer_id = req.params.id;
    const { event_id, status } = req.body;
    try {
        await db.execute(
            'INSERT INTO Event_Participants (event_id, customer_id, status) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status = ?',
            [event_id, customer_id, status, status]
        );
        // Đổi hướng về lại chính trang này để nhân viên thấy lịch sử vừa cập nhật
        res.redirect(`/staff/customers/${customer_id}/invite`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi gửi lời mời');
    }
});

// 7b. TÍNH NĂNG MỚI: Xử lý Cập nhật thẻ Điểm danh (Đã tham dự / Không tham dự...)
router.post('/customers/:customer_id/events/:event_id/update-status', isStaff, async (req, res) => {
    const { attendance_status } = req.body;
    try {
        await db.execute(
            'UPDATE Event_Participants SET status = ? WHERE customer_id = ? AND event_id = ?',
            [attendance_status, req.params.customer_id, req.params.event_id]
        );
        res.redirect(`/staff/customers/${req.params.customer_id}/invite`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi cập nhật trạng thái');
    }
});
// 8. XỬ LÝ XÓA KHÁCH HÀNG (Soft Delete)
router.post('/customers/delete/:id', isStaff, async (req, res) => {
    try {
        await db.execute('UPDATE Customers SET is_deleted = 1, deleted_at = NOW() WHERE id = ? AND staff_id = ?', [req.params.id, req.session.userId]);
        res.redirect('/staff/customers');
    } catch (err) {
        res.status(500).send('Lỗi xóa khách hàng');
    }
});

// 9. GIAO DIỆN THÙNG RÁC CỦA NHÂN VIÊN
router.get('/trash', isStaff, async (req, res) => {
    try {
        const [deletedCustomers] = await db.execute(
            'SELECT * FROM Customers WHERE staff_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC',
            [req.session.userId]
        );
        res.render('staff/trash', { deletedCustomers });
    } catch (err) {
        res.status(500).send('Lỗi tải thùng rác');
    }
});

// 10. XỬ LÝ KHÔI PHỤC KHÁCH HÀNG
router.post('/customers/restore/:id', isStaff, async (req, res) => {
    try {
        await db.execute('UPDATE Customers SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND staff_id = ?', [req.params.id, req.session.userId]);
        res.redirect('/staff/trash');
    } catch (err) {
        res.status(500).send('Lỗi khôi phục khách hàng');
    }
});
// 11. Tab danh sách sự kiện dành cho nhân viên [cite: 9]
router.get('/events', isStaff, async (req, res) => {
    try {
        // Lấy danh sách sự kiện sắp tới hoặc đang diễn ra [cite: 10]
        const [events] = await db.execute('SELECT * FROM Events ORDER BY start_time ASC');
        res.render('staff/events', { events });
    } catch (err) {
        res.status(500).send('Lỗi tải danh sách sự kiện');
    }
});

// 12. Xem chi tiết sự kiện và quản lý khách mời [cite: 8, 10]
router.get('/events/:id', isStaff, async (req, res) => {
    const eventId = req.params.id;
    try {
        // Lấy thông tin sự kiện và người phụ trách [cite: 8]
        const [eventData] = await db.execute('SELECT * FROM Events WHERE id = ?', [eventId]);
        const [managers] = await db.execute(`
            SELECT u.full_name, u.username, u.phone_1 FROM Event_Managers em 
            JOIN Users u ON em.user_id = u.id WHERE em.event_id = ?`, [eventId]);
        
        // Lấy danh sách khách hàng của chính nhân viên này đã thêm vào sự kiện [cite: 10, 21]
        const [participants] = await db.execute(`
            SELECT ep.*, c.full_name, c.phone_1 
            FROM Event_Participants ep 
            JOIN Customers c ON ep.customer_id = c.id 
            WHERE ep.event_id = ? AND c.staff_id = ?`, [eventId, req.session.userId]);

        // Lấy danh sách khách hàng chưa được mời vào sự kiện này để chọn [cite: 10]
        const [myCustomers] = await db.execute(`
            SELECT id, full_name FROM Customers 
            WHERE staff_id = ? AND is_deleted = 0 
            AND id NOT IN (SELECT customer_id FROM Event_Participants WHERE event_id = ?)`, 
            [req.session.userId, eventId]);

        res.render('staff/event-detail', { 
            event: eventData[0], 
            managers, 
            participants, 
            myCustomers,
            now: new Date() 
        });
    } catch (err) {
        res.status(500).send('Lỗi tải chi tiết sự kiện');
    }
});

// 13. Thêm khách hàng vào sự kiện [cite: 10]
router.post('/events/:id/add-customer', isStaff, async (req, res) => {
    const { customer_id, notes } = req.body;
    const eventId = req.params.id;
    try {
        // Chỉ cho phép thêm nếu sự kiện chưa kết thúc [cite: 10]
        const [event] = await db.execute('SELECT end_time FROM Events WHERE id = ?', [eventId]);
        if (new Date(event[0].end_time) < new Date()) {
            return res.send('Sự kiện đã kết thúc, không thể thêm khách!');
        }

        await db.execute(
            'INSERT INTO Event_Participants (event_id, customer_id, notes, status) VALUES (?, ?, ?, "Đã mời")',
            [eventId, customer_id, notes]
        );
        res.redirect(`/staff/events/${eventId}`);
    } catch (err) {
        res.status(500).send('Lỗi thêm khách vào sự kiện');
    }
});

// 14. Cập nhật ghi chú cho khách mời [cite: 10]
router.post('/events/:id/update-note', isStaff, async (req, res) => {
    const { customer_id, notes } = req.body;
    try {
        await db.execute(
            'UPDATE Event_Participants SET notes = ? WHERE event_id = ? AND customer_id = ?',
            [notes, req.params.id, customer_id]
        );
        res.redirect(`/staff/events/${req.params.id}`);
    } catch (err) {
        res.status(500).send('Lỗi cập nhật ghi chú');
    }
});

// 15. Xóa khách khỏi sự kiện (chỉ khi chưa kết thúc) 
router.post('/events/:id/remove-customer', isStaff, async (req, res) => {
    const eventId = req.params.id;
    try {
        const [event] = await db.execute('SELECT end_time FROM Events WHERE id = ?', [eventId]);
        if (new Date(event[0].end_time) < new Date()) {
            return res.send('Sự kiện đã kết thúc, không thể xóa khách mời!');
        }

        await db.execute('DELETE FROM Event_Participants WHERE event_id = ? AND customer_id = ?', [eventId, req.body.customer_id]);
        res.redirect(`/staff/events/${eventId}`);
    } catch (err) {
        res.status(500).send('Lỗi xóa khách mời');
    }
});

// Giao diện chi tiết & Sửa thông tin khách hàng
router.get('/customers/edit/:id', isStaff, async (req, res) => {
    try {
        const [customer] = await db.execute('SELECT * FROM Customers WHERE id = ? AND staff_id = ?', [req.params.id, req.session.userId]);
        if (customer.length === 0) return res.status(404).send('Không tìm thấy khách hàng');
        
        // Đã xóa phần query Customer_Interactions vì không còn dùng ở giao diện này nữa
        res.render('staff/edit-customer', { cust: customer[0] });
    } catch (err) {
        res.status(500).send('Lỗi tải thông tin');
    }
});

// 17. Xử lý nhân viên cập nhật thông tin khách hàng
router.post('/customers/edit/:id', isStaff, async (req, res) => {
    const { full_name, gender, phone_1, phone_2, birthday, cccd, address_1, address_2, email } = req.body;
    try {
        await db.execute(
            `UPDATE Customers SET 
            full_name = ?, gender = ?, phone_1 = ?, phone_2 = ?, birthday = ?, 
            cccd = ?, address_1 = ?, address_2 = ?, email = ? 
            WHERE id = ? AND staff_id = ?`,
            [full_name, gender || 'Chưa xác định', phone_1, phone_2 || null, birthday || null, cccd || null, address_1 || null, address_2 || null, email || null, req.params.id, req.session.userId]
        );
        res.redirect('/staff/customers');
    } catch (err) {
        res.status(500).send('Lỗi cập nhật thông tin');
    }
});
// ==========================================
// TÀI LIỆU NỘI BỘ (STAFF VIEW)
// ==========================================
router.get('/documents', isStaff, async (req, res) => {
    try {
        const [documents] = await db.execute('SELECT * FROM Documents ORDER BY created_at DESC');
        res.render('staff/documents', { documents });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách tài liệu');
    }
});

// ==========================================
// THÔNG BÁO CHO NHÂN VIÊN (STAFF NOTIFICATIONS)
// ==========================================
router.get('/notifications', isStaff, async (req, res) => {
    try {
        const [notifications] = await db.execute(`
            SELECT n.*, u.full_name as creator_name,
            IF(nr.user_id IS NOT NULL, 1, 0) as is_read
            FROM Notifications n
            LEFT JOIN Users u ON n.created_by = u.id
            LEFT JOIN Notification_Reads nr ON n.id = nr.notification_id AND nr.user_id = ?
            WHERE n.start_time <= NOW() AND n.end_time >= NOW()
            ORDER BY is_read ASC, n.start_time DESC
        `, [req.session.userId]);
        
        res.render('staff/notifications', { notifications });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải danh sách thông báo');
    }
});

// Đánh dấu đọc 1 thông báo
router.post('/notifications/read/:id', isStaff, async (req, res) => {
    await db.execute('INSERT IGNORE INTO Notification_Reads (user_id, notification_id) VALUES (?, ?)', [req.session.userId, req.params.id]);
    res.redirect('/staff/notifications');
});

// Đánh dấu đọc tất cả
router.post('/notifications/read-all', isStaff, async (req, res) => {
    await db.execute(`
        INSERT IGNORE INTO Notification_Reads (user_id, notification_id)
        SELECT ?, id FROM Notifications WHERE start_time <= NOW() AND end_time >= NOW()
    `, [req.session.userId]);
    res.redirect('/staff/notifications');
});

// ==========================================
// TRANG GIÁM SÁT ĐỘI NHÓM (Dành cho Team Leader)
// ==========================================
router.get('/my-team', isStaff, async (req, res) => {
    try {
        const myId = req.session.userId;
        const month = new Date().getMonth() + 1;
        const year = new Date().getFullYear();

        // 1. Kiểm tra lính trực thuộc
        const [teamMembers] = await db.execute(`
            SELECT id, full_name, avatar_url, phone_1 
            FROM Users 
            WHERE leader_id = ? AND is_deleted = 0
        `, [myId]);

        // NẾU KHÔNG CÓ LÍNH (Không phải Trưởng nhóm)
        if (teamMembers.length === 0) {
            // FIX LỖI Ở ĐÂY: Truyền đầy đủ isLeader, month, year và cả teamMembers rỗng
            return res.render('staff/team-monitor', { 
                isLeader: false,
                month: month,
                year: year,
                teamMembers: [] 
            });
        }

        // 2. Nếu CÓ LÍNH, lấy số liệu thống kê
        for (let i = 0; i < teamMembers.length; i++) {
            const memberId = teamMembers[i].id;

            // Đếm khách mới
            const [newCustResult] = await db.execute(
                'SELECT COUNT(*) as new_cust FROM Customers WHERE staff_id = ? AND MONTH(created_at) = ? AND YEAR(created_at) = ? AND is_deleted = 0', 
                [memberId, month, year]
            );
            
            // Đếm khách dự sự kiện
            const [attendedResult] = await db.execute(
                'SELECT COUNT(*) as attended FROM Event_Participants ep JOIN Customers c ON ep.customer_id = c.id WHERE c.staff_id = ? AND ep.status = "Đã tham dự"', 
                [memberId]
            );

            // Gán dữ liệu vào object
            teamMembers[i].stats = { 
                new_cust: newCustResult[0].new_cust, 
                attended: attendedResult[0].attended 
            };
        }

        // Trả về cho Trưởng nhóm
        res.render('staff/team-monitor', { isLeader: true, teamMembers, month, year });
    } catch (err) {
        console.error('Lỗi trang My Team:', err);
        res.status(500).send('Lỗi máy chủ khi tải dữ liệu đội nhóm');
    }
});

// ==========================================
// BẢNG XẾP HẠNG THI ĐUA (Dành cho Staff)
// ==========================================

// Helper tính toán điểm số (Sử dụng chung cấu trúc với Admin)
async function calculateLeaderboard(month, year) {
    const [configs] = await db.execute('SELECT * FROM KPI_Configs WHERE month = ? AND year = ?', [month, year]);
    if (configs.length === 0) return { config: null, leaderboard: [], teams: [] };
    const config = configs[0];

    const [kpiEvents] = await db.execute('SELECT event_id FROM KPI_Config_Events WHERE config_id = ?', [config.id]);
    const validEventIds = kpiEvents.map(e => e.event_id);
    const eventFilter = validEventIds.length > 0 ? `AND ep.event_id IN (${validEventIds.join(',')})` : `AND 1=0`;

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

    staffList.forEach(leader => {
        const teamMembers = staffList.filter(sub => sub.leader_id === leader.id);
        if (teamMembers.length > 0) {
            const teamTotalPoints = teamMembers.reduce((sum, sub) => sum + sub.personal_points, 0);
            leader.team_bonus = Math.round(teamTotalPoints * config.tl_coefficient);
        }
        leader.total_points = leader.personal_points + leader.team_bonus;
    });

    staffList.sort((a, b) => b.total_points - a.total_points);

    let currentRank = 1;
    for (let i = 0; i < staffList.length; i++) {
        if (i > 0 && staffList[i].total_points < staffList[i-1].total_points) {
            currentRank = i + 1;
        }
        staffList[i].rank = currentRank;
    }

    return { config, leaderboard: staffList };
}

router.get('/leaderboard', isStaff, async (req, res) => {
    try {
        const month = new Date().getMonth() + 1;
        const year = new Date().getFullYear();

        // 1. Kiểm tra cấu hình tháng hiện tại xem Admin có cho phép công khai không
        const [configs] = await db.execute('SELECT * FROM KPI_Configs WHERE month = ? AND year = ?', [month, year]);
        const config = configs.length > 0 ? configs[0] : null;

        // Nếu chưa có cấu hình hoặc Admin đang Tắt công khai (is_published = 0)
        if (!config || config.is_published === 0) {
            return res.render('admin/leaderboard', { 
                month, year, 
                config: { is_published: 0 }, // Giả lập để UI ẩn bảng xếp hạng
                leaderboard: [],
                userRole: 'Staff'
            });
        }

        // 2. Tính toán và truyền dữ liệu ra màn hình (Staff dùng chung file View với Admin)
        const data = await calculateLeaderboard(month, year);
        
        res.render('admin/leaderboard', { 
            month, year, 
            config: data.config, 
            leaderboard: data.leaderboard,
            userRole: 'Staff'
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải Bảng xếp hạng');
    }
});

// ==========================================
// 1. IMPORT KHÁCH HÀNG TỪ EXCEL
// ==========================================
router.post('/customers/import', isStaff, upload.single('excel_file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('Vui lòng chọn file Excel.');
        
        const myId = req.session.userId;
        
        // Đọc file Excel từ buffer (trong RAM)
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; // Lấy sheet đầu tiên
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let successCount = 0;

        for (let row of rows) {
            // Đọc các cột chuẩn (Giả sử file có cột: HoTen, SoDienThoai)
            const fullName = row['HoTen'] || row['Họ Tên'] || row['Name'];
            const phone = row['SoDienThoai'] || row['Số điện thoại'] || row['Phone'];
            
            if (fullName && phone) {
                const safePhone = String(phone).replace(/\D/g, ''); // Lọc lấy số
                await db.execute(
                    'INSERT INTO Customers (full_name, phone_1, staff_id) VALUES (?, ?, ?)',
                    [fullName.toUpperCase().trim(), safePhone, myId]
                );
                successCount++;
            }
        }

        res.send(`<script>alert("✅ Import thành công ${successCount} khách hàng!"); window.location.href="/staff/customers";</script>`);
    } catch (err) {
        console.error(err);
        res.send('<script>alert("🛑 Lỗi xử lý file Excel. Vui lòng kiểm tra lại định dạng!"); window.history.back();</script>');
    }
});

// ==========================================
// 2. LƯU NHẬT KÝ TELESALE & HẸN GIỜ
// ==========================================
router.post('/customers/:id/interaction', isStaff, async (req, res) => {
    const custId = req.params.id;
    const myId = req.session.userId;
    const { interaction_type, status, note, next_call_date } = req.body;

    try {
        // 1. Lưu nhật ký tương tác
        await db.execute(
            'INSERT INTO Customer_Interactions (customer_id, staff_id, interaction_type, status, note) VALUES (?, ?, ?, ?, ?)',
            [custId, myId, interaction_type, status, note]
        );

        // 2. Cập nhật ngày gọi lại vào hồ sơ khách hàng (nếu có hẹn)
        if (next_call_date) {
            await db.execute('UPDATE Customers SET next_call_date = ? WHERE id = ?', [next_call_date, custId]);
        }

        res.redirect('back');
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi lưu nhật ký');
    }
});

// ==========================================
// API LƯU GIAO DIỆN DASHBOARD (GRIDSTACK CHO STAFF)
// ==========================================
router.post('/dashboard/save-layout', isStaff, async (req, res) => {
    try {
        const layoutData = JSON.stringify(req.body.layout);
        await db.execute('UPDATE Users SET dashboard_layout = ? WHERE id = ?', [layoutData, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// API Xóa cấu hình Dashboard của Staff
router.post('/dashboard/reset-layout', isStaff, async (req, res) => {
    try {
        const userId = req.session.userId;
        // Đặt layout về NULL hoặc chuỗi rỗng
        await db.execute('UPDATE Users SET dashboard_layout = NULL WHERE id = ?', [userId]);
        res.json({ success: true, message: 'Đã khôi phục giao diện' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
});

// ==========================================
// CHI TIẾT KHÁCH HÀNG & NHẬT KÝ CHĂM SÓC
// ==========================================

// 1. Mở trang Chi tiết Khách hàng
router.get('/customers/:id', isStaff, async (req, res) => {
    try {
        const customerId = req.params.id;
        const staffId = req.session.userId;

        // Lấy thông tin khách (Đảm bảo chỉ lấy khách của Staff đang đăng nhập)
        const [customers] = await db.execute('SELECT * FROM Customers WHERE id = ? AND staff_id = ?', [customerId, staffId]);
        
        if (customers.length === 0) {
            return res.status(404).send('Không tìm thấy khách hàng hoặc bạn không có quyền truy cập.');
        }

        // Lấy danh sách Ghi chú (Sắp xếp mới nhất lên đầu)
        const [notes] = await db.execute('SELECT * FROM Customer_Notes WHERE customer_id = ? ORDER BY created_at DESC', [customerId]);

        res.render('staff/customer-detail', {
            customer: customers[0],
            notes: notes
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Lỗi tải dữ liệu khách hàng');
    }
});

// Lưu Ghi chú mới (Sử dụng AJAX - Không Redirect)
router.post('/customers/:id/notes', isStaff, async (req, res) => {
    try {
        const customerId = req.params.id;
        const staffId = req.session.userId;
        const { note_type, content, reminder_time } = req.body;

        const reminder = reminder_time ? reminder_time : null;

        // Lưu vào DB
        const [result] = await db.execute(
            'INSERT INTO Customer_Notes (customer_id, staff_id, note_type, content, reminder_time) VALUES (?, ?, ?, ?, ?)',
            [customerId, staffId, note_type, content, reminder]
        );

        // Trả về dữ liệu JSON dạng thành công kèm thông tin note vừa tạo
        return res.json({
            success: true,
            note: {
                id: result.insertId,
                note_type: note_type,
                content: content,
                reminder_time: reminder,
                created_at: new Date().toISOString()
            }
        });

    } catch (err) {
        console.error('Lỗi Lưu Note:', err);
        return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
});

module.exports = router;