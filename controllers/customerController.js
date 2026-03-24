const db = require('../config/db');
const { processKpiPoints } = require('../views/services/kpiService');

exports.addActiveCustomer = async (req, res) => {
    const { customer_id, active_code, active_date, notes } = req.body;
    const admin_username = req.user.username; // Lấy từ session/token đăng nhập

    try {
        // 1. Kiểm tra mã Active đã tồn tại chưa (Unique Check)
        const [existing] = await db.query('SELECT id FROM active_histories WHERE active_code = ?', [active_code]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: "Mã Active này đã tồn tại trên hệ thống!" });
        }

        // 2. Thêm vào lịch sử Active
        const [insertResult] = await db.query(`
            INSERT INTO active_histories (customer_id, active_code, active_date, notes, admin_username)
            VALUES (?, ?, ?, ?, ?)
        `, [customer_id, active_code, active_date, notes, admin_username]);

        const newActiveId = insertResult.insertId;

        // 3. Tìm nhân viên quản lý khách hàng này để cộng điểm
        const [customer] = await db.query('SELECT staff_id FROM customers WHERE id = ?', [customer_id]);
        
        if (customer.length > 0 && customer[0].staff_id) {
            // GỌI HÀM CỘNG ĐIỂM TỰ ĐỘNG
            await processKpiPoints(customer[0].staff_id, 'ACTIVE_CUSTOMER', newActiveId);
        }

        res.json({ success: true, message: "Xác nhận Active và tính điểm thành công!" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Lỗi Server!" });
    }
};

// Hàm Thu hồi Active (Soft Delete & Trừ điểm)
exports.deleteActiveCustomer = async (req, res) => {
    const { active_id } = req.params;

    try {
        // 1. Soft Delete bản ghi Active
        await db.query('UPDATE active_histories SET is_deleted = 1 WHERE id = ?', [active_id]);

        // 2. Lấy thông tin Log điểm cũ đã từng cộng cho hành động này
        const [oldLogs] = await db.query(`
            SELECT * FROM kpi_score_logs 
            WHERE reference_id = ? AND action_type = 'ACTIVE_CUSTOMER' AND points_changed > 0
        `, [active_id]);

        // 3. Trừ điểm hồi tố (Tạo một log mới với số điểm ÂM)
        for (const log of oldLogs) {
            await db.query(`
                INSERT INTO kpi_score_logs (staff_id, kpi_program_id, action_type, reference_id, points_changed, reason)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                log.staff_id, 
                log.kpi_program_id, 
                'REVERT_ACTIVE', // Phân loại là hành động thu hồi
                active_id, 
                -log.points_changed, // Chuyển thành số âm để trừ điểm
                `Thu hồi điểm do Admin xóa bản ghi Active`
            ]);
        }

        res.json({ success: true, message: "Đã xóa Active và thu hồi điểm liên quan!" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Lỗi Server!" });
    }
};