const db = require('../config/db');
const { recalculateProgramPoints } = require('../views/services/kpiService');

// [GET] Hiển thị trang quản lý KPI
exports.getIndex = async (req, res) => {
    try {
        const [programs] = await db.query('SELECT * FROM KPI_Programs ORDER BY created_at DESC');
        res.render('admin/kpi-settings', { programs });
    } catch (error) {
        console.error(error);
        res.status(500).send("Lỗi Server");
    }
};

// [POST] Tạo mới chương trình KPI
exports.createProgram = async (req, res) => {
    const { 
        title, description, start_date, end_date, is_stackable, 
        point_study, point_meeting, point_survey, point_active, point_event_default, point_recruit 
    } = req.body;

    try {
        await db.query(`
            INSERT INTO KPI_Programs 
            (title, description, start_date, end_date, is_stackable, point_study, point_meeting, point_survey, point_active, point_event_default, point_recruit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            title, description, start_date, end_date, is_stackable || 0,
            point_study || 0, point_meeting || 0, point_survey || 0, point_active || 0, point_event_default || 0, point_recruit || 0
        ]);
        
        res.redirect('/admin/kpi-settings');
    } catch (error) {
        console.error(error);
        res.status(500).send("Lỗi lưu dữ liệu");
    }
};

// [POST] Cập nhật chương trình KPI (Sau khi cập nhật nên gọi hàm Recalculate - sẽ làm ở bước sau)
exports.updateProgram = async (req, res) => {
    const { id } = req.params;
    const { 
        title, description, start_date, end_date, is_stackable, 
        point_study, point_meeting, point_survey, point_active, point_event_default, point_recruit 
    } = req.body;

    try {
        await db.query(`
            UPDATE KPI_Programs 
            SET title=?, description=?, start_date=?, end_date=?, is_stackable=?, 
                point_study=?, point_meeting=?, point_survey=?, point_active=?, point_event_default=?, point_recruit=?
            WHERE id=?
        `, [
            title, description, start_date, end_date, is_stackable || 0,
            point_study || 0, point_meeting || 0, point_survey || 0, point_active || 0, point_event_default || 0, point_recruit || 0, id
        ]);
        
        res.redirect('/admin/kpi-settings');
    } catch (error) {
        console.error(error);
        res.status(500).send("Lỗi cập nhật dữ liệu");
    }
};

// [POST] Nút bấm Đồng bộ / Tính lại điểm
exports.recalculateKpi = async (req, res) => {
    const { id } = req.params; // ID của chương trình KPI
    
    try {
        const result = await recalculateProgramPoints(id);
        
        if (result.success) {
            res.json({ success: true, message: result.message });
        } else {
            res.status(400).json({ success: false, message: result.message });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Lỗi Server!" });
    }
};

// [POST] Xóa chương trình KPI
exports.deleteProgram = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM KPI_Programs WHERE id=?', [id]);
        res.redirect('/admin/kpi-settings');
    } catch (error) {
        res.status(500).send("Lỗi xóa dữ liệu");
    }
};

// Thêm vào cuối file controllers/kpiController.js

exports.getKpiHistoryAPI = async (req, res) => {
    try {
        const userId = req.session?.userId || req.user?.id;
        const userRole = req.session?.role || req.user?.role;
        const targetStaffId = req.query.staff_id; // Dành cho Admin muốn xem 1 người cụ thể

        let query = `
            SELECT k.*, u.full_name, u.avatar_url 
            FROM KPI_Score_Logs k
            JOIN Users u ON k.staff_id = u.id
            WHERE 1=1
        `;
        let params = [];

        // 1. Phân quyền cho Staff (Chỉ thấy mình và tuyến dưới)
        if (userRole === 'Staff') {
            query += ` AND (k.staff_id = ? OR u.leader_id = ? OR u.recruiter_id = ?)`;
            params.push(userId, userId, userId);
        }

        // 2. Lọc theo 1 nhân sự cụ thể (Nếu có truyền id lên)
        if (targetStaffId) {
            query += ` AND k.staff_id = ?`;
            params.push(targetStaffId);
        }

        // 3. Sắp xếp mới nhất lên đầu, giới hạn 100 dòng để tối ưu tốc độ
        query += ` ORDER BY k.created_at DESC LIMIT 100`;

        const [logs] = await db.query(query, params);

        res.json({ success: true, logs });

    } catch (error) {
        console.error("Lỗi getKpiHistoryAPI:", error);
        res.status(500).json({ success: false, message: 'Lỗi server khi lấy lịch sử KPI' });
    }
};
// ==============================================================================
// Tên file: controllers/kpiController.js
// Vị trí: Thêm vào cuối file
// Chức năng: Render trang Báo cáo và API cung cấp dữ liệu Lịch sử KPI cho Admin
// ==============================================================================

// 1. Hàm render giao diện trang Báo cáo KPI
exports.renderKpiReportPage = (req, res) => {
    const user = req.session?.user || req.user || { role: 'Admin' };
    res.render('admin/kpi-report', { user });
};

// 2. API lấy danh sách Lịch sử KPI có kèm Bộ lọc
exports.getAdminKpiLogsAPI = async (req, res) => {
    try {
        const { search, action_type, start_date, end_date, limit = 50, offset = 0 } = req.query;

        let query = `
            SELECT k.*, u.full_name, u.avatar_url, u.phone_1 
            FROM KPI_Score_Logs k
            JOIN Users u ON k.staff_id = u.id
            WHERE 1=1
        `;
        let params = [];

        // Lọc theo tên hoặc SĐT nhân viên
        if (search) {
            query += ` AND (u.full_name LIKE ? OR u.phone_1 LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        // Lọc theo Loại hành động
        if (action_type && action_type !== 'ALL') {
            query += ` AND k.action_type = ?`;
            params.push(action_type);
        }

        // Lọc theo Ngày bắt đầu
        if (start_date) {
            query += ` AND DATE(k.created_at) >= ?`;
            params.push(start_date);
        }

        // Lọc theo Ngày kết thúc
        if (end_date) {
            query += ` AND DATE(k.created_at) <= ?`;
            params.push(end_date);
        }

        query += ` ORDER BY k.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [logs] = await db.query(query, params);

        res.json({ success: true, logs });

    } catch (error) {
        console.error("Lỗi getAdminKpiLogsAPI:", error);
        res.status(500).json({ success: false, message: 'Lỗi server khi tải báo cáo KPI' });
    }
};