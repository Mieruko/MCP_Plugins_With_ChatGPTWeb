# Kiểm thử Computer Use — 2026-09-27

Nhánh `codex/computer-use`, base `4c09b02`. Phát triển bằng tool Codex theo yêu cầu người dùng; không dùng connector Coder của dự án. Thay đổi chưa commit/push, CU mặc định tắt trong cấu hình mẫu. Không sửa `.env` hay restart server live.

## Phạm vi triển khai

- Giữ native MCP images/content và `isError` qua bridge/proxy/approval; giới hạn payload, cache media trong RAM theo task/operation; journal/history không nhân đôi typed binary.
- 5 tool CU đăng ký qua Workbench, machine scope cả capture, session sở hữu bởi task/conversation; profile/desktop lease, timeout, stale observation và revoke khi policy/writer/experience/lifecycle đổi. Task retarget yêu cầu đóng CU của chính conversation.
- Chrome/Edge adapter, upload qua chooser với file path được policy kiểm tra; Windows adapter riêng chỉ nhóm UI, title/focus check, không expose shell/evaluate.
- Job state lưu trên đĩa, poll một lần hoặc monitor đọc theo backoff có hạn, resume không replay, cancel phân biệt remote execution. Tiêu chí thành công là matching UI evidence được cấu hình, không phải xác minh dịch vụ độc lập.
- Dashboard status/Stop, hướng dẫn và notebook fixture Colab.

## Bằng chứng đã chạy

| Lệnh / phép thử | Kết quả |
| --- | --- |
| `npm test` | PASS; build TypeScript và regression dự án. Test glob cũ phụ thuộc mtime/top-50 được chuyển sang fixture riêng để không thất bại khi thêm file. |
| `npm run test:multimodal` | PASS; 7 nhóm unit và HTTP bridge/proxy/Ask integration. Text/image/structured/error, oversized refusal, một lần approval, scope/task isolation, journal/audit không chứa bytes ảnh, restart báo thiếu ảnh lịch sử rõ ràng. |
| `npm run test:computer` / `node scripts/test-computer-use.mjs` | PASS với Chrome và Edge headless thật qua HTTP MCP (Edge dùng COMPUTER_BROWSER=msedge); cả hai chạy thêm fault injection. Không chỉ mock lời gọi adapter. |
| CU policy/discovery | Flag off không thêm tool; flag on thêm 5 tool slim. Workspace-only bị từ chối trước spawn. Ask chờ rồi duyệt, Auto chờ và từ chối không spawn, Full thực thi. Basic writer khác không capture được; chuyển writer thu hồi session. |
| CU isolation | Hai conversation cùng task không chia sẻ session; hai task không đọc nhầm session/job. CU của conversation đang hoạt động chặn retarget; conversation khác vẫn đổi task được. |
| Browser fixture | Native screenshot, caption tiếng Việt, stale ID refusal, file thiếu bị từ chối, upload file có thật ngoài workspace dưới machine scope, chờ input text, kiểm tra marker/artifact, monitor kết thúc, error/URL khác, stop/resume/cancel. |
| Windows runtime install + sync | PASS; Python 3.14.7, Windows-MCP 0.8.6 và 92 phiên bản dependency khóa trong `scripts/computer-windows-requirements.txt`. Không sửa `.env` hoặc cài global. |
| `npm run test:computer:windows` | PASS handshake với backend đã cài; 6 schema Snapshot/Screenshot/Click/Type/Shortcut/Scroll, duplicate session refusal, transport close và release lease. Không gọi thao tác UI. |
| CU restart | PASS restart tiến trình server thật với cùng state, giữ job kết thúc và binding cuộc chat, không mở browser/monitor lại hoặc replay Run. Job đang dở được poll thành disconnected rồi resume vào session mới. |
| Fault injection + browser thật | PASS mất response sau click đã xảy ra: ID cũ bị vô hiệu, observe xác nhận số lần submit vẫn bằng 1. Stop lỗi: job chưa cancelled, lease vẫn revoked/giữ lại; retry đóng được rồi mới cancelled. |
| `git diff --check` | PASS (Git có cảnh báo chuyển LF/CRLF theo cấu hình, không có whitespace error). |
| Scheduled: `npm test` sau bản sửa | PASS, gồm routing HTTP/restart với status chỉ đọc, sai task, phiên mới chưa xác nhận dưới Ask/workspace-only, không tự mở quyền đọc source. Đã cập nhật assertion prompt launcher cũ rồi chạy lại toàn bộ suite thành công. |

Server kiểm thử dùng temporary workspace/state/cổng riêng, synthetic media, token riêng. Browser test không đăng nhập tài khoản thật. Notebook fixture chưa chạy trên Colab; test local dùng form HTML mô phỏng các trạng thái.

## Review quyền và dữ liệu

Task/session lấy từ execution context server, không từ argument client. CU có phân loại process/external trước nhánh read-only; không mở read exemption cho screenshot. Backend không nằm trong raw hub, nên model không gọi evaluate/shell qua handle CU. Full/machine vẫn cho browser/desktop truy cập theo tài khoản chạy server; đây không phải OS sandbox.

Open kiểm tra generation sau kết nối để policy/writer bị đổi trong lúc startup không tạo phiên hợp lệ muộn. Đóng session giữ lease đến khi transport đóng thành công; không tự chiếm lại lease sau crash. Theo dõi chỉ đọc, dừng nếu session bị revoke; thao tác đã gửi ra ngoài không rollback được. Pending chooser dùng bằng chứng click gốc vì Playwright không cho snapshot trong lúc chooser đang mở.

Child environment dùng allowlist không truyền Workbench/tunnel keys. Không ghi stderr backend vào log. JSON operation loại binary có type image/audio/resource; text và tham số vẫn có thể chứa nội dung nhạy cảm. Backend lưu file screenshot riêng trên đĩa theo task, ngưỡng dọn 32 MiB; cache ảnh approval trong RAM có TTL/cap riêng.

`npm audit` tại lần cài báo 8 findings (1 low, 5 moderate, 2 high) trong cây dependency hiện có: Hono/adapter, DOMPurify/Monaco, Express/qs, fast-uri và ip-address. Diff lock chỉ thêm `@playwright/mcp`, `playwright`, `playwright-core`; các package bị báo có sẵn trước thay đổi này. Không chạy audit fix làm đổi dependency không liên quan. Cần xử lý audit ở việc bảo trì riêng.

## Chưa nghiệm thu / bước tiếp theo

1. Windows dialog thật, focus switching, DPI 100%/150% và monitor phụ. Runtime/catalog đã pass; adapter dùng UI labels, không click raw tọa độ ảnh; capture có thể bao gồm toàn desktop. Lock dependency chính xác đã sync lại thành công nhưng chưa có hash artifact.
2. Browser headed, file ảnh/video lớn, Drive picker, iframe/prompt Colab thực tế, timeout ngay sau upload và reconnect qua tunnel. CU restart có đóng browser trước đã pass; crash khi backend đang thao tác vẫn cần kiểm thử. Lease sau crash giữ nguyên để người dùng xác minh trước khi gỡ.
3. Facebook: cần đích/account, media, caption, thời gian/timezone và phạm vi submit. Chưa có bằng chứng post scheduled/published thật hoặc cơ chế dedup dịch vụ; kiểm tra Published/Scheduled trước retry.
4. Colab: người dùng đã chọn notebook mẫu. Đã mở Colab trên Chrome bằng tool Codex và xác nhận phiên đăng nhập, dừng tại Browse vì tiện ích ChatGPT chưa bật `Allow access to file URLs`. Chưa upload/chạy notebook; cần người dùng bật quyền tiện ích trước khi tiếp tục. Đây là giới hạn của tool kiểm thử Codex, không phải lỗi upload của MCP Workbench. Notebook JSON và cú pháp Python đã kiểm tra local. Marker phải duy nhất cho lần chạy, không có sẵn trong source/historical output; UI substring match không chứng minh bytes artifact hay tác vụ nền ngoài trang đã hoàn tất.
5. ChatGPT web: Refresh connector sau khi chủ máy bật CU và restart vào thời điểm phù hợp; thử ảnh chỉ có mã ngẫu nhiên để xác nhận model nhận pixels qua tunnel. Chưa xác minh việc này bằng phiên ChatGPT web thực tế.

## Đợt cải tiến profile và tốc độ (27/09/2026)

Người dùng đã báo thử ChatGPT web: Chrome mở được, click test đạt 12/20 sau 4m28s rồi client safety checks từ chối. Đây là báo cáo của người dùng, không phải trace benchmark local; chưa có phép đo tách riêng thời gian model, connector và backend của lượt đó.

Đã bổ sung setup browser có giao diện, profile metadata, action snapshot/observation ID trả ngay, scoped target checks và repeat click 1–20. Giữ adapter/pin upstream, không sửa package đã cài. Setup theo task, không gắn trực tiếp Chrome cá nhân; Windows chưa thêm batch hoặc bỏ focus guard.

| Kiểm thử đợt này | Bằng chứng |
| --- | --- |
| `npm test` | PASS exit 0 sau thay đổi core/admin/schema/prompt. |
| `CU_TEST_SETUP_HEADED=true node scripts/test-computer-use.mjs` | PASS exit 0: 20 click qua HTTP MCP trong 2964 ms, reuse observation; setup dashboard mở Chrome headed thật rồi đóng, chặn automation/lease trùng, không đổi policy/writer; workspace-only setup bị từ chối. Cùng suite vẫn pass upload, Ask/Auto/Full, Basic writer, task isolation và restart. |
| `node scripts/test-computer-performance.mjs` | PASS Chrome: 20 click với quảng cáo giả lập thay đổi mỗi 50 ms, khoảng 5,3 s; kiểm tra bộ đếm thật 20, không chỉ đếm lệnh gửi. |
| `COMPUTER_BROWSER=msedge node scripts/test-computer-performance.mjs` | PASS Edge: cùng fixture 20 click khoảng 5,6 s; target/modal guard, loss response và profile persistence. |
| Partial/unknown | Target đổi hoặc dialog xuất hiện dừng sau 1 click. Mất response ở click thứ 3 báo 2 acknowledged + 1 uncertain; UI thực tế tăng 3 và không replay. |
| Snapshot file scope | Link snapshot giả trỏ ra ngoài output task bị từ chối; không đọc/lộ sentinel file và vẫn báo action đã acknowledged. |
| Profile persistence | Cookie persistent và localStorage giữ qua close/reopen cùng task; task khác không kế thừa. Chưa dùng credential Facebook/Google/Shopee để thử. |
| `node scripts/test-computer-faults.mjs` | PASS exit 0; single click loss response và retry Stop lỗi vẫn đúng. |
| Dashboard UI | Chrome headless render 1280 px / 390 px, mock API: setup submit đúng một request, hiển thị Save/close; không tràn ngang. Screenshot `.computer-use-runtime/computer-use-setup.png` là fixture, không phải tài khoản thật. |

Các thời gian trên đo local một lần/fixture, không phải cam kết độ trễ ChatGPT web hoặc toàn bộ workflow. Thời gian settle 100 ms không chứng minh remote job hoàn tất. Khả năng login vào từng dịch vụ, ảnh qua ChatGPT/tunnel và lỗi safety checks độc lập phía client vẫn chưa nghiệm thu sau bản cải tiến. Đã build nhưng chưa tự restart server live, đổi `.env`, policy hay dữ liệu đăng nhập.

M1–M2 đạt kiểm thử local; M3–M7 có code và giới hạn như trên, không đánh dấu hoàn tất toàn bộ tiêu chí thực tế. Nguồn schema Windows đã đối chiếu với [snapshot](https://github.com/CursorTouch/Windows-MCP/blob/97979d6f6ff987f591ccfad8d2c15b9103db1091/src/windows_mcp/tools/snapshot.py) và [input](https://github.com/CursorTouch/Windows-MCP/blob/97979d6f6ff987f591ccfad8d2c15b9103db1091/src/windows_mcp/tools/input.py) tại revision pin.

## Yêu cầu bổ sung: Scheduled trong ChatGPT web

Đã thêm kiểm tra binding vào `workbench(view=status,expected_task_id)` và receipt/audit, cập nhật hướng dẫn để bỏ `target` không cần thiết trên lượt tiếp tục đã đúng task. `workbench_control` vẫn khai báo đúng khả năng thay đổi state. Chưa nghiệm thu Scheduled thật; không kết luận server có thể bỏ qua safety checks của ChatGPT. Phân tích, bằng chứng log và mẫu prompt ReSrc ở [Scheduled troubleshooting](scheduled-mcp-troubleshooting.md).
