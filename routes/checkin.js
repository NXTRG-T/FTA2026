const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { processKpiPoints } = require('../views/services/kpiService');

// 1. Mở trang Check-in Mobile cho Khách hàng
router.get('/:event_id', async (req, res) => {
    const { event_id } = req.params;
    const { token } = req.query;

    try {
        // Kiểm tra tính hợp lệ của Token mã QR (Chống quét ảnh cũ)
        const [events] = await db.execute(
            'SELECT event_name FROM Events WHERE id = ? AND qr_token = ? AND qr_valid_to > NOW()',
            [event_id, token]
        );

        if (events.length === 0) {
            return res.render('checkin-error', { message: 'Mã QR đã hết hạn hoặc không hợp lệ. Vui lòng quét lại mã mới trên màn hình!' });
        }

        res.render('checkin-mobile', { event_id, token, event_name: events[0].event_name });
    } catch (err) {
        res.status(500).send('Lỗi máy chủ');
    }
});

// 2. Xử lý logic Điểm danh (API dùng Fetch)
router.post('/:event_id/process', async (req, res) => {
    const event_id = req.params.event_id;
    const { phone, full_name, ref_phone, token } = req.body;

    try {
        // 1. Xác thực lại Token một lần nữa (Bảo mật kép)
        const [eventCheck] = await db.execute('SELECT id FROM Events WHERE id = ? AND qr_token = ? AND qr_valid_to > NOW()', [event_id, token]);
        if (eventCheck.length === 0) return res.json({ success: false, message: 'Mã QR đã quá hạn. Vui lòng quét lại!' });

        // 2. Tìm khách hàng theo SĐT
        const safePhone = phone.replace(/\D/g, '');
        const [customers] = await db.execute('SELECT id, full_name FROM Customers WHERE phone_1 = ? AND is_deleted = 0', [safePhone]);

        // KỊCH BẢN A: KHÁCH CŨ HOẶC ĐÃ CÓ TRONG CRM
        if (customers.length > 0) {
            const customerId = customers[0].id;
            
            // Lấy staff_id phụ trách để cộng điểm
            const [custInfo] = await db.execute('SELECT staff_id FROM Customers WHERE id = ?', [customerId]);
            const staffId = custInfo[0]?.staff_id;

            // Kiểm tra xem đã có tên trong danh sách sự kiện chưa
            const [participantCheck] = await db.execute('SELECT * FROM Event_Participants WHERE event_id = ? AND customer_id = ?', [event_id, customerId]);
            
            let isNewAttend = false;

            if (participantCheck.length > 0) {
                if (participantCheck[0].status !== 'Đã tham dự') {
                    await db.execute('UPDATE Event_Participants SET status = "Đã tham dự" WHERE event_id = ? AND customer_id = ?', [event_id, customerId]);
                    isNewAttend = true;
                }
            } else {
                // Chưa có tên (Khách của nhân viên khác dắt đi ké) -> Thêm vào sự kiện
                await db.execute('INSERT INTO Event_Participants (event_id, customer_id, status) VALUES (?, ?, "Đã tham dự")', [event_id, customerId]);
                isNewAttend = true;
            }

            // Trả điểm Check-in cho nhân viên phụ trách
            if (isNewAttend && staffId) {
                const [events] = await db.execute(`SELECT * FROM Events WHERE id = ?`, [event_id]);
                const customEventPoint = events[0]?.kpi_points || 0;
                await processKpiPoints(staffId, 'EVENT_ATTEND', event_id, customEventPoint);
            }
            
            return res.json({ success: true, message: `Chào mừng ${customers[0].full_name} đã đến sự kiện!` });
        }

        // KỊCH BẢN B: KHÁCH VÃNG LAI HOÀN TOÀN MỚI
        if (!full_name) {
            // Nếu chưa gửi kèm Tên -> Báo cho Frontend mở form nhập Tên
            return res.json({ success: false, need_info: true });
        } else {
            // Nếu đã gửi Tên -> Tạo Lead mới (Để trống staff_id là NULL nếu không có SĐT giới thiệu)
            // ... (Logic nâng cao xử lý SĐT giới thiệu có thể viết thêm ở đây) ...
            const [newCust] = await db.execute('INSERT INTO Customers (full_name, phone_1) VALUES (?, ?)', [full_name.toUpperCase(), safePhone]);
            await db.execute('INSERT INTO Event_Participants (event_id, customer_id, status) VALUES (?, ?, "Đã tham dự")', [event_id, newCust.insertId]);
            return res.json({ success: true, message: `Check-in thành công! Cảm ơn ${full_name} đã đăng ký.` });
        }
    } catch (err) { console.error(err); res.json({ success: false, message: 'Lỗi xử lý, vui lòng thử lại.' }); }
});

module.exports = router;