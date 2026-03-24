const axios = require('axios');
const db = require('../config/db'); // Đưa import Database lên đầu file
const { processKpiPoints } = require('../views/services/kpiService');

// URL của Apps Script lưu CV (Folder ở email it)
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyr-7AuEHcGSUPTO7JWEQsVly31OxODWm8yH7hmQR6mQJjIL60eyjg81nuWhbDxg-pOcA/exec';

exports.submitApplication = async (req, res) => {
    const { full_name, phone_1, email, referral_code } = req.body;
    const file = req.file; // File CV lấy từ multer
    let cvUrl = null;
    let recruiterId = null;

    try {
        // 1. Nếu có upload CV -> Bắn sang Google Apps Script
        if (file) {
            // Chuyển buffer của file thành Base64
            const base64Data = file.buffer.toString('base64');
            // Bắn API sang Google Apps Script
            const gasResponse = await axios.post(GAS_WEB_APP_URL, {
                base64: base64Data,
                fileName: `CV_${full_name.replace(/\s+/g, '_')}_${Date.now()}.${file.originalname.split('.').pop()}`,
                mimeType: file.mimetype
            }, {
                headers: { 'Content-Type': 'application/json' },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            // Kiểm tra xem GAS có trả về trang HTML báo lỗi quyền truy cập không
            if (typeof gasResponse.data === 'string' && gasResponse.data.includes('<html')) {
                console.error("❌ LỖI QUYỀN TRUY CẬP: Google Apps Script đang chặn request. Bạn phải cấp quyền 'Anyone' khi Deploy!");
            }
            else if (gasResponse.data && gasResponse.data.success) {
                cvUrl = gasResponse.data.fileUrl;
                console.log("✅ Đã lưu CV lên Drive thành công: ", cvUrl);
            } else {
                console.error("❌ Lỗi từ Google Apps Script:", gasResponse.data ? gasResponse.data.message : 'Không rõ lỗi');
            }
            //     base64: base64Data,
            //     fileName: `CV_${full_name.replace(/\s+/g, '_')}_${Date.now()}.${file.originalname.split('.').pop()}`,
            //     mimeType: file.mimetype
            // });

            // if (gasResponse.data.success) {
            //     cvUrl = gasResponse.data.fileUrl; // Lấy link Drive thành công
            // }
        }

        // 2. Xử lý Logic tìm Người giới thiệu (Recruiter) từ referral_code
        if (referral_code) {
            const [recruiter] = await db.query('SELECT id FROM Users WHERE business_code = ? OR username = ?', [referral_code, referral_code]);
            if (recruiter.length > 0) {
                recruiterId = recruiter[0].id;
            }
        }

        // 3. Lưu toàn bộ vào Database (Bảng users)
        await db.query(`
            INSERT INTO Users (full_name, phone_1, email, work_status, role, cv_url, recruiter_id)
            VALUES (?, ?, ?, 'APPLIED', 'Candidate', ?, ?)
        `, [full_name, phone_1, email, cvUrl, recruiterId]);

        res.status(200).json({ success: true, message: 'Ứng tuyển thành công!' });

    } catch (error) {
        console.error("Lỗi Upload CV:", error);
        res.status(500).json({ success: false, message: 'Lỗi hệ thống' });
    }
};

// 1. [GET] Hiển thị Bảng Kanban Ứng viên
// exports.getKanbanBoard = async (req, res) => {
//     try {
//         const userId = req.session.userId;
//         const userRole = req.session.role;

//         // Thay vì 1 câu Query khổng lồ lấy toàn bộ, ta chia làm 5 câu Query có LIMIT để tránh tràn RAM
//         const statuses = ['APPLIED', 'INTERVIEWING', 'PROBATION', 'OFFICIAL', 'REJECTED'];
//         const boardData = {};

//         for (let status of statuses) {
//             let query = `SELECT * FROM Users WHERE work_status = ?`;
//             let params = [status];


//             query += ` ORDER BY id DESC LIMIT 50 OFFSET 0`;
//             const [rows] = await db.query(query, params);
//             boardData[status] = rows;
//         }

//         // Render ra file candidates.ejs (Tùy thuộc vào việc đặt ở views/admin hay views/staff)
//         const viewPath = userRole === 'Admin' ? 'admin/candidates' : 'staff/candidates';
//         res.render(viewPath, { boardData, user: { role: userRole, referral_code: req.session.username } });

//     } catch (error) {
//         console.error("Lỗi lấy dữ liệu Kanban:", error);
//         res.status(500).send("Lỗi Server!");
//     }
// };
// Nằm trong file: controllers/recruitmentController.js

exports.loadMoreCandidates = async (req, res) => {
    try {
        const { status, offset } = req.query;
        // Lấy thông tin user an toàn, tránh lỗi undefined
        const userId = req.session?.userId || req.user?.id;
        const userRole = req.session?.role || req.user?.role;

        let query = `SELECT * FROM Users WHERE work_status = ?`;
        let params = [status];

        // KHÓA QUYỀN: Staff chỉ tải thêm được người do mình giới thiệu HOẶC người mình quản lý
        if (userRole === 'Staff') {
            query += ` AND (recruiter_id = ? OR leader_id = ?)`;
            params.push(userId, userId);
        }

        query += ` ORDER BY created_at DESC LIMIT 50 OFFSET ?`;
        params.push(parseInt(offset));

        const [candidates] = await db.query(query, params);

        res.json({ success: true, candidates });

    } catch (error) {
        console.error("Lỗi loadMoreCandidates:", error);
        res.status(500).json({ success: false, message: 'Lỗi server' });
    }
};
exports.getKanbanBoard = async (req, res) => {
    try {
        // Lấy thông tin user đăng nhập (Tùy theo cấu trúc session của bạn)
        const userId = req.session.userId || req.user.id;
        const userRole = req.session.role || req.user.role;
        // Nếu hệ thống không có sẵn object user, tự động tạo một object chứa các thông tin cần thiết để truyền ra EJS
        const user = req.session?.user || req.user || {
            id: userId,
            role: userRole,
            referral_code: req.session?.referral_code || '' // Tránh lỗi undefined khi copy link
        };

        // Câu lệnh SQL mặc định (Dành cho Admin - Thấy tất cả)
        let query = `SELECT * FROM Users WHERE work_status IN ('APPLIED', 'INTERVIEWING', 'PROBATION', 'OFFICIAL', 'REJECTED')`;
        let params = [];
        // ĐÂY LÀ ĐOẠN PHÂN QUYỀN MỚI: LẤY NGƯỜI DO MÌNH GIỚI THIỆU HOẶC DO MÌNH QUẢN LÝ
        if (userRole === 'Staff') {
            query += ` AND (recruiter_id = ? OR leader_id = ?)`;
            params.push(userId, userId); // Truyền userId 2 lần cho 2 dấu chấm hỏi
        }

        query += ` ORDER BY created_at DESC LIMIT 50`;

        const [candidates] = await db.query(query, params);

        // Đóng gói dữ liệu gửi ra Frontend
        const boardData = {
            APPLIED: candidates.filter(c => c.work_status === 'APPLIED'),
            INTERVIEWING: candidates.filter(c => c.work_status === 'INTERVIEWING'),
            PROBATION: candidates.filter(c => c.work_status === 'PROBATION'),
            OFFICIAL: candidates.filter(c => c.work_status === 'OFFICIAL'),
            REJECTED: candidates.filter(c => c.work_status === 'REJECTED')
        };

        // Quyết định render ra giao diện nào dựa vào Role
        if (userRole === 'Admin') {
            res.render('admin/candidates', { boardData, user });
        } else {
            res.render('staff/candidates', { boardData, user });
        }

    } catch (error) {
        console.error("Lỗi getKanbanBoard:", error);
        res.status(500).send("Lỗi máy chủ");
    }
};

// 2. [POST] Cập nhật trạng thái khi kéo thả (Kịch bản thông thường)
exports.updateCandidateStatus = async (req, res) => {
    const { candidate_id, status } = req.body;
    try {
        await db.query(`UPDATE Users SET work_status = ? WHERE id = ?`, [status, candidate_id]);

        // --- KÍCH HOẠT TÍNH ĐIỂM KHI KÉO THẢ TRẠNG THÁI ---
        if (status === 'PROBATION' || status === 'OFFICIAL') {
            const [candidateInfo] = await db.query('SELECT recruiter_id FROM Users WHERE id = ?', [candidate_id]);
            if (candidateInfo.length > 0 && candidateInfo[0].recruiter_id) {
                await processKpiPoints(candidateInfo[0].recruiter_id, 'RECRUIT_SUCCESS', candidate_id);
            }
        }

        res.json({ success: true, message: 'Cập nhật trạng thái thành công' });
    } catch (error) {
        console.error("Lỗi cập nhật trạng thái:", error);
        res.status(500).json({ success: false, message: 'Lỗi Database' });
    }
};

// ====================================================
// API: TẢI THÊM THẺ KANBAN (PAGINATION)
// ====================================================
exports.loadMoreCards = async (req, res) => {
    try {
        const { status, offset } = req.query;
        const limit = 50;
        const userId = req.session.userId;
        const userRole = req.session.role;

        let query = `SELECT * FROM Users WHERE work_status = ?`;
        let params = [status];


        query += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
        params.push(Number(limit), Number(offset));

        const [candidates] = await db.query(query, params);
        res.json({ success: true, candidates });
    } catch (error) {
        console.error("Lỗi phân trang Kanban:", error);
        res.status(500).json({ success: false });
    }
};

// 3. [POST] Duyệt ứng viên & Tạo tài khoản đăng nhập CRM (Kéo vào Thử việc / Chính thức)
exports.approveCandidate = async (req, res) => {
    const { candidate_id, new_status, username, password, probation_start_date, probation_end_date } = req.body;

    try {
        // Kiểm tra xem Username đã tồn tại chưa
        const [existing] = await db.query('SELECT id FROM Users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Tên đăng nhập đã tồn tại!' });
        }

        // Mã hóa mật khẩu (Nếu hệ thống dùng plain text thì bỏ qua đoạn bcrypt này)
        // const hashedPassword = await bcrypt.hash(password, 10); 
        const hashedPassword = password; // Giả định hệ thống đang dùng plain text theo file JSON của bạn

        // Lấy thông tin người giới thiệu để cộng điểm KPI
        const [candidateInfo] = await db.query('SELECT recruiter_id FROM Users WHERE id = ?', [candidate_id]);

        // Cập nhật Database biến Ứng viên thành Staff
        await db.query(`
            UPDATE Users 
            SET username = ?, 
                password = ?, 
                role = 'Staff', 
                work_status = ?, 
                is_locked = 0,
                probation_start_date = ?, 
                probation_end_date = ?
            WHERE id = ?
        `, [username, hashedPassword, new_status, probation_start_date || null, probation_end_date || null, candidate_id]);

        // ==========================================
        // TÍCH HỢP GAMIFICATION: CỘNG ĐIỂM TUYỂN DỤNG
        // ==========================================
        if ((new_status === 'PROBATION' || new_status === 'OFFICIAL') && candidateInfo[0]?.recruiter_id) {
            await processKpiPoints(candidateInfo[0].recruiter_id, 'RECRUIT_SUCCESS', candidate_id);
        }

        res.json({ success: true, message: 'Tạo tài khoản và duyệt nhân sự thành công!' });

    } catch (error) {
        console.error("Lỗi duyệt ứng viên:", error);
        res.status(500).json({ success: false, message: 'Lỗi Database' });
    }
};

// Thêm vào cuối controllers/recruitmentController.js

exports.getTeamMembersAPI = async (req, res) => {
    try {
        const userId = req.session?.userId || req.user?.id;
        
        // Nhận các tham số từ Frontend truyền lên
        const { leader_id, limit = 20, offset = 0, search, status, sort_by } = req.query;

        // Bắt buộc phải có leader_id (nếu không truyền lên thì mặc định lấy lính của chính user đang đăng nhập)
        const targetLeaderId = leader_id || userId;

        // Câu lệnh gốc
        let query = `
            SELECT id, full_name, phone_1, avatar_url, work_status, created_at 
            FROM Users 
            WHERE (leader_id = ? OR recruiter_id = ?)
        `;
        let params = [targetLeaderId, targetLeaderId];

        // 1. Xử lý Tìm kiếm (Search)
        if (search) {
            query += ` AND (full_name LIKE ? OR phone_1 LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        // 2. Xử lý Lọc Trạng thái (Filter)
        if (status && status !== 'ALL') {
            query += ` AND work_status = ?`;
            params.push(status);
        }

        // 3. Xử lý Sắp xếp (Sort)
        if (sort_by === 'newest') {
            query += ` ORDER BY created_at DESC`;
        } else if (sort_by === 'name_asc') {
            query += ` ORDER BY full_name ASC`;
        } else {
            query += ` ORDER BY created_at DESC`; // Mặc định
        }

        // 4. CHỐT CHẶN BẢO VỆ RAM: Phân trang (Limit / Offset)
        query += ` LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        // Thực thi truy vấn
        const [members] = await db.query(query, params);

        res.json({ success: true, members });

    } catch (error) {
        console.error("Lỗi getTeamMembersAPI:", error);
        res.status(500).json({ success: false, message: 'Lỗi server khi tải danh sách' });
    }
};
// ==============================================================================
// Tên file: controllers/recruitmentController.js (hoặc file controller tương ứng)
// Vị trí code: Thêm vào cuối file
// Chức năng: Truy vấn danh sách F1 (Quản lý trực tiếp) và Render trang team-monitor
// ==============================================================================

exports.getIndexTeamMonitor = async (req, res) => {
    try {
        const userId = req.session?.userId || req.user?.id;
        const user = req.session?.user || req.user || { role: 'Staff' };

        // Lấy danh sách F1 (Người do Staff này quản lý trực tiếp HOẶC giới thiệu)
        // Kèm theo tính toán: Tổng lính F2 bên dưới và Tổng điểm KPI của cả nhánh F1 đó
        const query = `
            SELECT 
                u1.id, u1.full_name, u1.avatar_url, u1.phone_1,
                (SELECT COUNT(id) FROM Users WHERE leader_id = u1.id OR recruiter_id = u1.id) as total_f2,
                (SELECT COALESCE(SUM(points_changed), 0) FROM kpi_score_logs WHERE staff_id IN 
                    (SELECT id FROM Users WHERE leader_id = u1.id OR recruiter_id = u1.id OR id = u1.id)
                ) as total_team_kpi
            FROM Users u1
            WHERE u1.leader_id = ? OR u1.recruiter_id = ?
            ORDER BY total_team_kpi DESC
        `;
        
        const [f1List] = await db.query(query, [userId, userId]);

        // Trả dữ liệu ra file giao diện (kèm biến user để không bị lỗi undefined)
        res.render('staff/team-monitor', { f1List, user });

    } catch (error) {
        console.error("Lỗi getIndexTeamMonitor:", error);
        res.status(500).send("Lỗi tải trang giám sát đội nhóm");
    }
};