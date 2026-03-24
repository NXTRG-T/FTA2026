// ==============================================================================
// Tên file: controllers/adminController.js
// Chức năng: Lưu cấu hình JSON của GridStack vào đúng cột trong DB
// ==============================================================================

exports.saveDashboardLayout = async (req, res) => {
    try {
        const userId = req.session.userId;
        const { layout, type } = req.body;
        
        // Xác định lưu vào cột Desktop hay Mobile dựa trên tham số 'type' truyền lên
        const column = (type === 'mobile') ? 'mobile_layout' : 'dashboard_layout';
        
        const query = `UPDATE Users SET ${column} = ? WHERE id = ?`;
        await db.query(query, [JSON.stringify(layout), userId]);

        res.json({ success: true, message: 'Đã cập nhật giao diện cá nhân' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};