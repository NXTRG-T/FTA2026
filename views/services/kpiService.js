const db = require('../../config/db'); // Import kết nối database của bạn

/**
 * Hàm xử lý cộng điểm KPI tự động
 * @param {Number} staff_id - ID của nhân viên (users table)
 * @param {String} action_type - Loại hành động (VD: 'ACTIVE_CUSTOMER', 'EVENT_ATTEND')
 * @param {Number} reference_id - ID bản ghi gốc (ID của active_history hoặc event_participant)
 * @param {Number} custom_point - Điểm tùy chỉnh (Dùng cho sự kiện có điểm riêng, mặc định null)
 */
async function processKpiPoints(staff_id, action_type, reference_id, custom_point = null) {
    try {
        // [QUAN TRỌNG] Kiểm tra điểm Tuyển dụng để đảm bảo 1 ứng viên chỉ mang lại điểm 1 lần duy nhất
        if (action_type === 'RECRUIT_SUCCESS') {
            const [existingLogs] = await db.query(
                `SELECT id FROM kpi_score_logs WHERE action_type = 'RECRUIT_SUCCESS' AND reference_id = ?`,
                [reference_id]
            );
            if (existingLogs.length > 0) return; // Đã từng cộng điểm rồi thì thoát ngay lập tức
        }

        // 1. Tìm các chương trình KPI ĐANG HOẠT ĐỘNG (Dựa theo thời gian hiện tại)
        const [activePrograms] = await db.query(`
            SELECT * FROM kpi_programs 
            WHERE NOW() BETWEEN start_date AND end_date 
            ORDER BY created_at DESC
        `);

        if (activePrograms.length === 0) return; // Không có KPI nào đang chạy thì bỏ qua

        let programsToApply = [];

        // 2. Xử lý Logic Bật/Tắt cộng dồn (Stackable)
        const hasStackable = activePrograms.some(p => p.is_stackable === 1);
        
        if (hasStackable) {
            // Chế độ ON: Áp dụng cho TẤT CẢ chương trình đang chạy
            programsToApply = activePrograms;
        } else {
            // Chế độ OFF: Chỉ áp dụng chương trình MỚI NHẤT (ưu tiên index 0 vì đã ORDER BY DESC)
            programsToApply = [activePrograms[0]];
        }

        // 3. Tiến hành cộng điểm vào bảng Log
        for (const program of programsToApply) {
            let pointsToAward = 0;

            // Xác định số điểm theo loại hành động
            if (action_type === 'ACTIVE_CUSTOMER') pointsToAward = program.point_active;
            else if (action_type === 'EVENT_ATTEND') {
                // Nếu sự kiện có điểm riêng thì lấy điểm riêng, không thì lấy điểm mặc định
                pointsToAward = custom_point !== null && custom_point > 0 ? custom_point : program.point_event_default;
            }
            else if (action_type === 'RECRUIT_SUCCESS') {
                pointsToAward = program.point_recruit || 0; // Tránh lỗi undefined nếu DB chưa có cột
            }
            // Thêm các action_type khác như SURVEY, STUDY, MEETING vào đây...

            if (pointsToAward > 0) {
                await db.query(`
                    INSERT INTO kpi_score_logs (staff_id, kpi_program_id, action_type, reference_id, points_changed, reason)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    staff_id, 
                    program.id, 
                    action_type, 
                    reference_id, 
                    pointsToAward, 
                    `Cộng điểm tự động cho hành động: ${action_type}`
                ]);
            }
        }
    } catch (error) {
        console.error("Lỗi khi xử lý điểm KPI:", error);
    }
}

/**
 * Hàm quét và tính toán lại toàn bộ điểm của 1 chương trình KPI
 * @param {Number} programId - ID của chương trình KPI cần tính lại
 */
async function recalculateProgramPoints(programId) {
    try {
        // 1. Lấy thông tin "Luật chơi" mới nhất của chương trình này
        const [programs] = await db.query('SELECT * FROM kpi_programs WHERE id = ?', [programId]);
        if (programs.length === 0) return { success: false, message: 'Không tìm thấy chương trình' };
        const program = programs[0];

        // 2. CLEAR LOG CŨ: Xóa sạch toàn bộ điểm đã từng cộng/trừ của chương trình này
        await db.query('DELETE FROM kpi_score_logs WHERE kpi_program_id = ?', [programId]);

        // ==========================================
        // 3. TÍNH LẠI ĐIỂM ACTIVE KHÁCH HÀNG
        // ==========================================
        if (program.point_active > 0) {
            // Tìm tất cả Active hợp lệ trong khoảng thời gian của chương trình
            const [actives] = await db.query(`
                SELECT ah.id, c.staff_id 
                FROM active_histories ah
                JOIN customers c ON ah.customer_id = c.id
                WHERE ah.is_deleted = 0 
                  AND ah.active_date BETWEEN ? AND ?
                  AND c.staff_id IS NOT NULL
            `, [program.start_date, program.end_date]);

            // Cộng lại điểm
            for (let act of actives) {
                await db.query(`
                    INSERT INTO kpi_score_logs (staff_id, kpi_program_id, action_type, reference_id, points_changed, reason)
                    VALUES (?, ?, 'ACTIVE_CUSTOMER', ?, ?, 'Hồi tố điểm Active Khách hàng')
                `, [act.staff_id, program.id, act.id, program.point_active]);
            }
        }

        // ==========================================
        // 4. TÍNH LẠI ĐIỂM SỰ KIỆN (EVENT_ATTEND)
        // ==========================================
        // Tìm tất cả khách đã Check-in trong thời gian chạy KPI
        const [attendees] = await db.query(`
            SELECT ep.customer_id, ep.event_id, e.kpi_points, c.staff_id 
            FROM event_participants ep
            JOIN events e ON ep.event_id = e.id
            JOIN customers c ON ep.customer_id = c.id
            WHERE ep.status = 'Đã tham dự' 
              AND e.start_time BETWEEN ? AND ?
              AND c.staff_id IS NOT NULL
        `, [program.start_date, program.end_date]);

        for (let att of attendees) {
            // Ưu tiên: Nếu sự kiện có điểm riêng > 0 thì lấy, không thì lấy điểm mặc định
            let pts = (att.kpi_points && att.kpi_points > 0) ? att.kpi_points : program.point_event_default;
            
            if (pts > 0) {
                await db.query(`
                    INSERT INTO kpi_score_logs (staff_id, kpi_program_id, action_type, reference_id, points_changed, reason)
                    VALUES (?, ?, 'EVENT_ATTEND', ?, ?, 'Hồi tố điểm Tham dự Sự kiện')
                `, [att.staff_id, program.id, att.event_id, pts]);
            }
        }

        // ==========================================
        // 5. TÍNH LẠI ĐIỂM KHẢO SÁT (SURVEY)
        // ==========================================
        if (program.point_survey > 0) {
            const [surveys] = await db.query(`
                SELECT s.id, c.staff_id 
                FROM surveys s
                JOIN customers c ON s.customer_id = c.id
                WHERE s.completed_at BETWEEN ? AND ?
                  AND c.staff_id IS NOT NULL
            `, [program.start_date, program.end_date]);

            for (let srv of surveys) {
                await db.query(`
                    INSERT INTO kpi_score_logs (staff_id, kpi_program_id, action_type, reference_id, points_changed, reason)
                    VALUES (?, ?, 'SURVEY', ?, ?, 'Hồi tố điểm Khảo sát')
                `, [srv.staff_id, program.id, srv.id, program.point_survey]);
            }
        }

        // ==========================================
        // 6. TÍNH LẠI ĐIỂM TUYỂN DỤNG (RECRUIT_SUCCESS)
        // ==========================================
        if (program.point_recruit > 0) {
            const [recruits] = await db.query(`
                SELECT id, recruiter_id 
                FROM Users
                WHERE role = 'Staff' 
                  AND work_status IN ('PROBATION', 'OFFICIAL')
                  AND created_at BETWEEN ? AND ?
                  AND recruiter_id IS NOT NULL
            `, [program.start_date, program.end_date]);

            for (let rec of recruits) {
                await db.query(`
                    INSERT INTO kpi_score_logs (staff_id, kpi_program_id, action_type, reference_id, points_changed, reason)
                    VALUES (?, ?, 'RECRUIT_SUCCESS', ?, ?, 'Hồi tố điểm Tuyển dụng thành công')
                `, [rec.recruiter_id, program.id, rec.id, program.point_recruit]);
            }
        }

        return { success: true, message: 'Đã tính toán lại toàn bộ điểm thành công!' };
    } catch (error) {
        console.error("Lỗi Recalculate KPI:", error);
        return { success: false, message: 'Lỗi Database khi tính lại điểm' };
    }
}

module.exports = { processKpiPoints, recalculateProgramPoints };