# Kế hoạch triển khai Computer Use

Ngày: 2026-09-27. Nhánh: `codex/computer-use`.
Base: `main` tại `4c09b02d87e63a765b7a9b3bbb0c28e7a1b750df`.
Trạng thái: **đã triển khai bản CU đầu tiên; browser/local MCP đã kiểm thử, nghiệm thu desktop và Facebook/Colab thật còn mở**.

Hướng dẫn: [Computer Use](computer-use.md). Bằng chứng và giới hạn: [Báo cáo kiểm thử](computer-use-verification.md).

Tham chiếu: [Nghiên cứu và quyết định kiến trúc](computer-use-research.md).

## 1. Mục tiêu nghiệm thu

ChatGPT web gọi MCP Workbench để hoàn thành hai luồng:

- **Facebook:** mở đúng tài khoản/đích đăng, chọn ảnh hoặc video trên máy, nhập mô tả tiếng Việt, đăng hoặc lên lịch theo ngày/giờ/múi giờ được chỉ định, xác minh bài trong Published/Scheduled và không đăng trùng khi retry.
- **Google Colab:** mở đúng notebook/tool được chỉ định, nhập tham số, chạy đúng cell/form, xử lý yêu cầu text/file phát sinh, theo dõi đến khi có kết quả hoặc lỗi rõ ràng, xác minh artifact đầu ra nếu có.

Giải pháp kết hợp Playwright MCP cho browser và Windows-MCP cho desktop/native dialog. Workbench sở hữu lớp tool, policy, session, job và audit. Chỉ chuyển sang desktop khi thao tác browser được phép nhưng backend không hỗ trợ; tuyệt đối không dùng fallback để vượt từ chối quyền.

Không bao gồm trong phiên bản đầu: tự động vượt đăng nhập/2FA/CAPTCHA, mua gói Colab, agent API tự quyết định khi ChatGPT đóng, scheduler tự đăng bài thay cho chức năng lên lịch của Facebook, hoặc arbitrary code execution thông qua CU.

## 2. Các quyết định đã chốt

- CU là capability tùy chọn, mặc định tắt; khi bật, slim chỉ bổ sung tool CU cần thiết, không mở toàn bộ upstream.
- Giữ nguyên quyền Ask/Auto/Full và phạm vi của task. Desktop/browser có tác động ngoài workspace; không coi một profile nằm trong workspace là sandbox OS.
- Dùng browser profile riêng giữ đăng nhập. Mỗi profile chỉ có một controller được cấp lease; browser context/session phải gắn task và conversation phía server. Extension nối browser đang mở là tùy chọn, kiểm thử sau luồng profile riêng.
- Upload bằng file input/file chooser của browser trước; hộp thoại Windows là phương án tiếp theo. Phân biệt file local, Google Drive và filesystem runtime Colab.
- Mỗi chuỗi thao tác ngắn trả observation mới. Không lấy screenshot cũ để click sau khi cửa sổ, tab, scale hoặc focus đã đổi.
- Không dùng thời gian chờ cố định làm bằng chứng hoàn tất. Kết luận thành công cần UI state và điều kiện đầu ra của workflow cụ thể.
- Tái sử dụng backend đã có, pin phiên bản và dependency trong quá trình triển khai; không cài global. Ghi rõ runtime và vị trí profile/cache/output/venv.

## 3. Hợp đồng tool dự kiến

Tên/schema cuối cùng có thể tinh chỉnh khi code nhưng phải giữ các ranh giới sau:

| Tool | Trách nhiệm | Ràng buộc |
| --- | --- | --- |
| `computer_session` | Status, mở/đóng, acquire/release session browser hoặc desktop | Phân quyền theo action; không nhận task ID làm nguồn thẩm quyền từ client |
| `computer_observe` | UI tree ngắn, ảnh, tab/window identity, observation ID | Kiểm tra quyền capture và session trước nhánh read-only chung |
| `computer_act` | Navigate, click, type, key, scroll, select, wait có giới hạn | Discriminated union Zod; action nằm trong allowlist; kiểm tra target và observation |
| `computer_upload` | Chọn file đã được cấp quyền cho browser/native chooser | Resolve/validate path từ execution context, kiểm tra file tồn tại và đúng target |
| `computer_job` | Đọc trạng thái, tiếp tục, hủy job | Tách quyền theo action; cancellation có kết quả rõ, không ngầm khởi chạy lại |

Output giữ envelope `ok/tool/summary/data`; bổ sung native MCP image content ngoài text. Metadata có `session_id`, `observation_id`, URL hoặc window identity, timestamp và hệ tọa độ khi dùng ảnh. Giữ `isError` đúng; giới hạn kích thước ảnh, cây UI, log và thời gian mỗi call. Không nhân đôi base64 trong structuredContent hoặc audit.

Job state dự kiến: `created`, `running`, `waiting_input`, `succeeded`, `failed`, `disconnected`, `cancelled`, `unknown`. `unknown` dùng khi thao tác có thể đã xảy ra nhưng chưa xác minh được; phải observe/reconcile trước khi retry.

## 4. Thứ tự triển khai và điều kiện hoàn thành

### M1 — Sửa nền tảng kết quả MCP

Phạm vi dự kiến:

- `src/lib/tool-result.ts`: hỗ trợ content bổ sung và MCP isError, giữ tương thích output text hiện hữu.
- `src/tools/mcp-bridge.ts`, `src/lib/mcp-tool-proxy.ts`: bảo toàn text + image + structuredContent + isError; không stringify image object.
- Kiểm tra đường lưu kết quả approval/review không làm mất ảnh hoặc ghi base64 quá lớn. Ảnh của thao tác GUI được duyệt chậm phải coi là observation cũ; observe mới trước bước tiếp theo.
- Bổ sung fixture upstream đa phương thức vào test bridge/upstream.

Hoàn thành khi: test qua MCP thật giữ nguyên các loại content và lỗi; tool text cũ không đổi contract; kết quả bị giới hạn rõ mà không cắt hỏng ảnh base64.

### M2 — Thẩm quyền, session và tool discovery

Phụ thuộc M1.

- Đăng ký CU qua `src/server-factory.ts` để Workbench wrap handler; cập nhật `src/lib/tool-profile.ts` theo feature flag.
- Khai báo capability/effects trong `src/lib/workbench.ts`, không suy quyền từ prefix hoặc upstream annotation. Capture phải kiểm tra scope riêng trước nhánh “read always allowed”.
- Thêm CU session manager, registry backend và capability allowlist tại điểm thực thi. Kiểm tra cả `mcp_call` và proxy để không có đường raw gọi tool CU ngoài policy.
- Browser ownership theo task/conversation và profile; desktop lease toàn máy/desktop, độc lập khóa worktree. Thu hồi lease khi stop, chuyển writer, hết hạn hoặc reconnect không xác thực được.
- Giữ pending approval: duyệt thực thi yêu cầu gốc; không gửi lại. Nếu observation/focus đã đổi khi duyệt, trả stale-state, không click vị trí cũ.

Hoàn thành khi: test Ask/Auto/Full, workspace-only, WRITER_REQUIRED, hai task và hai conversation qua dispatch thật; không lẫn phiên và không gọi raw vượt allowlist. CU tắt không sinh backend process hoặc bổ sung tool.

### M3 — Browser adapter và upload

Phụ thuộc M2.

- Thêm adapter Playwright MCP được giới hạn capability; khởi động/kết thúc process theo session, timeout và cleanup rõ.
- Chọn Chrome/Edge, profile riêng và backend version đã kiểm tra trên Windows. Không tự nhập cookies/mật khẩu từ browser khác.
- Thực hiện navigate/observe/click/type/select/scroll/upload; trả ảnh và UI tree dùng được. Backend thiếu capability thì báo rõ, không giả thành công.
- Đọc file từ execution context và chính sách hiện tại; chống path traversal, file thiếu, sai target, upload chưa hoàn tất và timeout sau side effect.
- Tạo trang fixture local có input text, dropdown, file upload, progress và trạng thái thành công/lỗi.

Hoàn thành khi: Chrome/Edge qua MCP hoàn thành form local bằng tiếng Việt, upload đúng file, xác minh kết quả; hai task không dùng nhầm profile/tab. Thử ảnh chỉ chứa mã ngẫu nhiên qua ChatGPT web để xác minh model nhận được pixels.

### M4 — Windows adapter cho native dialog

Phụ thuộc M2; tích hợp luồng upload sau M3.

- Môi trường Python riêng cho Windows-MCP, pin version; tắt telemetry trong cấu hình thử nghiệm, chỉ expose nhóm UI được duyệt.
- Xử lý active window, native file picker, text tiếng Việt, DPI, resize ảnh và monitor offset. Chuyển browser → desktop phải giữ cùng workflow ownership và cấp đủ scope.
- Cho phép người dùng dừng/take over; ngừng thao tác tiếp khi lease bị thu hồi. Không tự chạy backend elevated.

Hoàn thành khi: chọn đúng file từ native dialog, không tác động cửa sổ khác; test DPI 100%/150%, monitor phụ và focus thay đổi; nút stop có hiệu lực.

### M5 — Job manager và vòng lặp chờ/nhập liệu

Phụ thuộc M3; M4 bổ sung khi job cần native dialog.

- Lưu task/conversation, session/target, bước, observation, input còn thiếu, mốc thời gian, output và attempt ID. Không lưu cookies hoặc credential trong job log.
- Poll có timeout/backoff và kết quả gọn; mỗi MCP call kết thúc trong thời gian hữu hạn. Thử process restart và transport reconnect với kho trạng thái fixture riêng.
- Chỉ tiếp tục sau khi xác minh session/lease và trạng thái thực. Không replay mù thao tác submit/run sau timeout.
- Thiết kế cancel phân biệt dừng điều khiển/poll với interrupt execution Colab: nếu không xác minh notebook đã dừng, phải báo rõ điều đó.
- Worker local chỉ theo dõi các tín hiệu đã lập trình; bước cần quyết định/đầu vào mới chuyển waiting_input. Không tuyên bố MCP có thể tự đánh thức ChatGPT.

Hoàn thành khi: job giữ đúng trạng thái khi chờ input, lỗi, mất kết nối và restart; reconnect không tạo hành động trùng hoặc báo thành công giả.

### M6 — Workflow Facebook và Colab

Phụ thuộc M3–M5.

Facebook:

- Xác định đúng account/Page/group/profile và khả năng đăng/lên lịch của giao diện thực tế. Không hardcode mọi đích đều hỗ trợ Schedule.
- Chọn media, chờ upload/xử lý, điền mô tả, thời gian và timezone. Ghi dấu attempt theo target/content/media/time để hỗ trợ đối chiếu, không coi dấu local là bằng chứng Facebook đã nhận bài.
- Sau submit, đọc Published/Scheduled, đối chiếu nội dung/media/thời gian và lấy ID/link nếu có. Khi chưa rõ, chuyển unknown và reconcile trước retry.

Colab:

- Đối chiếu URL/notebook/cell/form người dùng chỉ định; không dùng Run all trừ khi phạm vi yêu cầu cho phép.
- Hỗ trợ form input và prompt text/file xuất hiện trong output cell, gồm iframe nếu có; chọn backend phù hợp với UI quan sát được.
- Phân biệt cell đang chạy, chờ input, exception và runtime disconnect. Tiêu chí succeeded theo cell mục tiêu và artifact/output mong đợi, không chỉ dựa spinner hoặc dòng log cuối.
- Tạo notebook fixture có nhập text, upload file, xử lý có delay, lỗi chủ động và tạo output để kiểm thử lặp lại.

Hoàn thành khi: hai workflow chạy qua ChatGPT web với dữ liệu thử được cấp, có bằng chứng trạng thái cuối. Bài Facebook thật chỉ submit khi người dùng đã chỉ định đích/nội dung/lịch và cho phép thao tác đó; hiện tại chưa có yêu cầu đăng bài cụ thể.

### M7 — Dashboard, tài liệu và nghiệm thu

Phụ thuộc M1–M6; làm UI tối thiểu phục vụ stop/session ngay trong M2–M5.

- Hiển thị backend enabled/health, session owner, target, job progress, waiting input và stop/release. Không hiển thị secret hay base64 trong log mặc định.
- Hướng dẫn cài runtime riêng, kết nối browser/profile, refresh connector và xử lý lỗi thật; không sửa policy/control file bằng tay.
- Đọc skills `workbench-security-review` và `workbench-verify` lúc review/verify implementation. Test fixture dùng cổng/thư mục riêng, không restart server đang phục vụ người dùng.
- Chạy build, regression liên quan và integration trước; chạy suite đầy đủ tại mốc hợp nhất. Đo latency, tool calls và tỷ lệ hoàn thành; ghi hạn chế còn lại.

Hoàn thành khi: tất cả tiêu chí bắt buộc pass hoặc có hạn chế được ghi rõ; tắt CU vẫn dùng file/shell/Git bình thường; tài liệu phân biệt việc đã kiểm thử và khả năng chưa kiểm thử.

## 5. Ma trận kiểm thử bắt buộc

| Nhóm | Trường hợp |
| --- | --- |
| Transport | Text + image, structured + image, isError, oversized payload, approval result, tunnel |
| Quyền | Ask, Auto, Full; workspace-only; writer khác; policy đổi khi chờ; raw upstream bypass |
| Session | Hai task, hai chat, hai worktree, profile dùng chung, desktop lease, stale observation |
| Browser/file | Unicode, file thiếu, file ngoài scope, upload lớn, file picker web/Windows/Drive |
| Job | Waiting input, timeout trước/sau side effect, reconnect, process restart, cancel, unknown |
| Facebook | Ảnh và video; mô tả; timezone; scheduled record; retry không trùng |
| Colab | Đúng notebook/cell; nhập text và file giữa lúc chạy; exception; disconnect; artifact cuối |

Test scripts hiện có cần mở rộng/chạy khi code: `scripts/test-mcp-upstream.mjs`, `scripts/test-mcp-bridge-integration.mjs`, `scripts/test-tool-profile.mjs`, `scripts/test-control-permissions.mjs`, `scripts/test-conversation-routing.mjs`, `scripts/test-parallel-sessions.mjs`. Thêm test CU chuyên biệt theo từng milestone, không chỉ mock đường gọi trực tiếp mà bỏ qua Workbench.

## 6. Dữ liệu cần ở mốc thử thật

- Facebook: đích đăng, tài khoản đã đăng nhập, media path, mô tả, ngày/giờ/timezone và phạm vi được phép submit.
- Colab: notebook URL, tool/cell mục tiêu, tham số, file input và điều kiện đầu ra mong đợi.
- Môi trường: browser/profile chọn dùng và nơi được phép thử desktop.

Các dữ liệu này không chặn code và test fixture. Theo yêu cầu mới nhất, phát triển bằng tool của Codex, không gọi connector Coder đang được xây dựng. Test dùng server/state/cổng riêng; chưa kiểm tra lại tunnel hoặc phiên ChatGPT web live.

## 7. Cách bắt đầu và rollback

Đã hoàn tất M1 và tiếp tục lớp CU, browser, job, dashboard. M1 được kiểm thử độc lập trước khi bổ sung backend; không restart server live khi phát triển.

Chia implementation theo milestone thành các commit có thể review. Adapter browser/Windows được bật độc lập bằng cấu hình; khi tắt thì ngừng worker, thu hồi lease và không expose tool tương ứng. Không xóa profile hay file output của người dùng trong rollback. Cải tiến multimodal của M1 giữ độc lập với CU.

Checklist tiến độ:

- [x] Tạo nhánh riêng và lập kế hoạch.
- [x] M1 — Kết quả MCP đa phương thức, approval retrieval và cache giới hạn.
- [x] M2 — Tool discovery, task/conversation/profile lease, policy/writer/retarget guard; HTTP tests Ask/Auto/Full, scope, hai task/hai chat.
- [ ] M3 — Browser/upload đã code và pass Chrome và Edge headless thật. Còn file media lớn và thử nhận pixels trong ChatGPT web.
- [ ] M4 — Adapter Windows, Python 3.14.7 riêng và dependency lock đã cài/sync; handshake và 6 schema UI pass. Chưa nghiệm thu native dialog, DPI/monitor.
- [ ] M5 — Job persistence, poll/monitor, resume/cancel và restart server thật đã pass. Fault injection xác nhận không replay click sau mất response và không báo cancelled khi Stop lỗi. Còn crash khi đang thao tác, timeout sau upload và reconnect tunnel.
- [ ] M6 — Có checklist Facebook/Colab và notebook fixture. Chưa xác minh trên tài khoản/notebook thật; chưa có bộ selector Facebook/Colab cố định hoặc fingerprint chống trùng xuyên job.
- [ ] M7 — Có dashboard Stop, cấu hình, tài liệu, security review và regression. Nghiệm thu end-to-end và đo workflow latency/tỷ lệ hoàn thành vẫn mở.

Đợt cải tiến sau thử nghiệm người dùng: dashboard đã có nút mở browser headed để thiết lập profile task và Save/close; đã kiểm tra cookie/localStorage qua reopen. Browser action trả ngay snapshot + ID để giảm lượt, repeat 1–20 với kiểm tra mỗi click, partial/unknown rõ ràng. Local 20 click đạt khoảng 3 giây qua HTTP MCP trên trang tĩnh, 5–6 giây trên fixture quảng cáo động; chưa đo lại ChatGPT web. Xem báo cáo kiểm thử để biết phạm vi cụ thể; không coi đây là nghiệm thu đăng nhập Facebook/Colab/Shopee.

Thay đổi đang nằm trên `codex/computer-use`, chưa commit/push. Đã cài optional dependency Playwright trong repository; không sửa `.env`, policy live hoặc cấu hình tunnel, không đăng bài hay chạy Colab thật. Checklist để mở khi tiêu chí nghiệm thu chưa đủ; không coi test local là bằng chứng hoàn thành hai workflow thực tế.
