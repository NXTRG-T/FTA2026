const db = require('../config/db');
const { recalculateProgramPoints } = require('../views/services/kpiService');

// [GET] Hiển thị trang quản lý KPI
exports.getIndex = async (req, res) => {
    try {
        const [programs] = await db.query('SELECT * FROM kpi_programs ORDER BY created_at DESC');
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
        point_study, point_meeting, point_survey, point_active, point_event_default 
    } = req.body;

    try {
        await db.query(`
            INSERT INTO kpi_programs 
            (title, description, start_date, end_date, is_stackable, point_study, point_meeting, point_survey, point_active, point_event_default)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            title, description, start_date, end_date, is_stackable || 0,
            point_study || 0, point_meeting || 0, point_survey || 0, point_active || 0, point_event_default || 0
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
        point_study, point_meeting, point_survey, point_active, point_event_default 
    } = req.body;

    try {
        await db.query(`
            UPDATE kpi_programs 
            SET title=?, description=?, start_date=?, end_date=?, is_stackable=?, 
                point_study=?, point_meeting=?, point_survey=?, point_active=?, point_event_default=?
            WHERE id=?
        `, [
            title, description, start_date, end_date, is_stackable || 0,
            point_study || 0, point_meeting || 0, point_survey || 0, point_active || 0, point_event_default || 0, id
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