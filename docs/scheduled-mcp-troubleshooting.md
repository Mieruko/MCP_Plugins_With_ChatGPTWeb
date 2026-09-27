# Scheduled trong ChatGPT web: xác minh task trước khi chạy

## Hiện tượng và phạm vi bản sửa

Người dùng báo Scheduled trong ChatGPT web liên tục bị “safety checks” từ chối cả `workbench_control(action=target)` lẫn `action=status`, trong khoảng 01:00–17:00. Task được yêu cầu là ReSrc `9875d438-7794-4aa8-a268-a23a804b7830`.

Đã xác nhận từ code: `workbench_control` chứa cả thao tác thay đổi task/policy nên có annotation `readOnlyHint=false`, kể cả khi argument là `status`. Hướng dẫn cũ còn yêu cầu gọi lại control để xác minh task. Đây là phụ thuộc không cần thiết khi cuộc chat đã có binding đúng; chưa có bằng chứng nó là nguyên nhân duy nhất của thông báo safety checks phía ChatGPT.

Bản sửa bổ sung `workbench(view=status, expected_task_id=<UUID>)` vào tool chỉ đọc hiện có. Server đối chiếu task hiện tại với ID mong đợi và trạng thái binding đã xác nhận. Nó không chọn task, không cấp writer, không đổi policy và không đọc source của task được nêu trong argument. `workbench_control(action=status)` vẫn hoạt động để giữ tương thích; annotation của control vẫn là mutating.

- `verification.matches=true`, `TASK_VERIFIED`: có thể tiếp tục theo quyền hiện tại, không gọi lại `target`.
- `TASK_MISMATCH` hoặc `TASK_UNCONFIRMED`, `isError=true`: dừng công việc project; cần gắn task trong một lượt tương tác được người dùng cho phép. Không tự dùng task đang chọn ở Dashboard.
- Phản hồi có `server_received_at`; audit thêm `workbench/binding_status` với ID task và kết quả kiểm tra, không ghi token hoặc nội dung source. Audit là best effort: thiếu dòng log không chứng minh request chưa tới server.

Đã cập nhật server initialization, agent prompt và prompt launcher để dùng bước chỉ đọc này trước mỗi lượt tiếp tục. Nếu client đã từ chối một tool qua safety checks, không thử một đường tool khác để vượt từ chối. Đây là quy trình cho các lượt chạy mới sau khi cập nhật, không phải cơ chế retry lời gọi bị chặn.

## Mẫu phần xác minh cho lịch ReSrc

Giữ nguyên nội dung nghiên cứu, giới hạn và lịch của người dùng; thay phần xác minh task bằng đoạn sau sau khi server/connector đã được cập nhật:

```text
Task được giao: ReSrc, ID 9875d438-7794-4aa8-a268-a23a804b7830.
Đầu mỗi lượt, gọi workbench(view="status",
expected_task_id="9875d438-7794-4aa8-a268-a23a804b7830").
Chỉ tiếp tục khi verification.matches=true. Khi đúng, không gọi lại target;
đọc task_handoff(action="read") và context cần thiết rồi thực hiện phạm vi
công việc đã được giao, dưới policy hiện tại.
Nếu sai task, binding chưa xác nhận, cần approval hoặc client từ chối,
báo chính xác trạng thái và dừng phần việc phụ thuộc. Không đổi policy,
không tự chọn task khác và không gọi tool thay thế để vượt từ chối.
```

Một lịch tạo cuộc chat mới có thể không có `_meta["openai/session"]` hoặc không dùng lại binding cũ. ID viết trong prompt không tự cấp quyền hay xác nhận binding. Kiểm thử đã bảo đảm trường hợp mới/chưa xác nhận không mở quyền đọc file nhờ lời gọi status.

## Phân biệt lớp lỗi

| Bằng chứng | Kết luận có thể đưa ra |
| --- | --- |
| ChatGPT nói safety checks từ chối, không có response MCP | Chưa có bằng chứng server thực thi tool. Không gọi đây là timeout hoặc lỗi server nếu chưa có log tương ứng. |
| Có `server_received_at` và `verification` | Handler kiểm tra task đã nhận lời gọi. Đối chiếu binding/kết quả thay vì retarget mù. |
| `approval_required` có operation ID | Workbench đã nhận và đang chờ duyệt. Sau khi duyệt, đọc operation đó; không gửi lại thao tác. |
| `WRITER_REQUIRED`, `SANDBOX_UNAVAILABLE`, `TASK_UNCONFIRMED` | Lỗi quyền/phạm vi/binding có mã cụ thể; không tự chuyển tool hoặc bật Full. |
| HTTP 401, lỗi tunnel hoặc transport | Điều tra kết nối/auth riêng; không suy từ thông báo safety checks. |

Kiểm tra local ngày 27/09/2026: không có audit trong khung 01:00–17:00 UTC+07 ngày 27/09 (ngày đang được giả định từ trao đổi); log cũ không bao phủ đầy đủ control calls. Khoảng 21:13 UTC+07, không có listener trên hai cổng được cấu hình 3000/3001; health ở 3000 và activity ở 3001 đều trả `ECONNREFUSED`. Đây là tình trạng kết nối tại lúc kiểm tra, không chứng minh server đã dừng trong khung giờ Scheduled báo lỗi. Chưa xác định được nguyên nhân client từ chối hoặc xác minh lần Scheduled thật sau sửa.

## Áp dụng và nghiệm thu

Thay đổi hiện ở nhánh `codex/computer-use`, chưa triển khai vào server đang chạy. Build/test dùng server và control state tạm riêng. Không sửa cấu hình, policy live hoặc lịch ChatGPT của người dùng.

Khi áp dụng bản build mới vào thời điểm phù hợp, Refresh connector để ChatGPT nhận schema/hướng dẫn mới. Trong lượt tương tác, xác nhận đúng binding trước khi chạy lại lịch. Sau đó nghiệm thu một lượt Scheduled: response có timestamp mới, task đúng, `verification.matches=true`, và công việc được giao có kết quả. Nếu client tiếp tục từ chối, giữ nguyên ranh giới và điều tra quyền connector/Scheduled; server không thể bảo đảm vượt kiểm tra độc lập của ChatGPT.

Tài liệu OpenAI hiện mô tả automation có thể dùng connected tools có sẵn trong cuộc chat: [Automations](https://learn.chatgpt.com/docs/automations). Annotation phải phản ánh đúng tác động của tool, không thay thế authorization: [MCP server](https://developers.openai.com/plugins/build/mcp-server).
