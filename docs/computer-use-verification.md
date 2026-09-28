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

## Sửa Windows `COMPUTER_UI_CHANGED` (28/09/2026)

Người dùng báo Audio Wave Studio đọc được UI nhưng click/type/Tab đều bị chặn. Kiểm tra adapter phát hiện Windows đang hash toàn bộ text desktop, gồm cursor, taskbar và UI ngoài ứng dụng. Các thay đổi này có thể gây false positive dù cửa sổ đích không đổi; chưa có cặp snapshot của phiên Audio Wave Studio để quy chính xác trường nào đã thay đổi trong phiên đó.

Đã sửa:

- So sánh desktop, title/handle/kích thước cửa sổ foreground, toàn bộ cây control của nó (gồm tọa độ, focus, value, hierarchy) và handle/depth/status/kích thước các cửa sổ khác. Bỏ cursor, screenshot metadata, title động và cây control của ứng dụng nền. Cửa sổ mới/đổi handle, layout, modal hoặc control vẫn bị chặn; không tắt guard.
- `windows_targets` cung cấp label riêng cho mỗi observation, ánh xạ tới tọa độ control đã quan sát và xác minh lại. Không dùng index nội bộ Windows-MCP: bản 0.8.6 nhận label nhưng không in chúng trong semantic tree, thứ tự array nội bộ cũng khác cây hiển thị. Click/type/scroll thiếu label hợp lệ bị từ chối.
- Ảnh và cây UI lấy trong cùng Snapshot; bỏ Screenshot riêng vì đường đó ghi đè desktop_state bằng cây rỗng. Window title phải khớp chính xác. Snapshot thiếu/khác format, trùng window name hoặc bị cắt bị từ chối.

Kiểm chứng:

- `npm test`: PASS exit 0, gồm build và các regression core/permission/routing/workbench.
- `node scripts/test-computer-use.mjs`: PASS exit 0 qua server HTTP và Chrome thật; 20 click khoảng 3 giây, upload, Unicode, snapshot, stale guard, policy/writer, isolation và restart.
- `npm run test:computer:windows`: kiểm tra handshake/schema runtime thật; dùng renderer Python thật trên dữ liệu giả lập, không chụp desktop. Fixture transport tái hiện cursor/clock thay đổi: click/type/Tab/scroll được gửi đúng một lần. Focus/title/handle/tọa độ/control/modal đổi vẫn chặn; mất response không replay. Đây là kiểm thử adapter, không phải bằng chứng thao tác native Audio Wave Studio đã PASS.

Chưa restart server/tunnel đang dùng, không đổi `.env` hay policy. Bản build cần được server nạp lại rồi mới thử lại trên ChatGPT. Native UI, DPI/multiple monitors và quy trình Audio Wave Studio vẫn chưa được nghiệm thu trong lượt sửa này. Snapshot/preflight/action vẫn có khoảng thời gian không nguyên tử với thao tác của người dùng hoặc ứng dụng khác.

### Tiếp tục: `COMPUTER_OBSERVE_FORMAT` và tọa độ ngẫu nhiên

Tái hiện trên runtime Windows-MCP thật bằng `scripts/diagnose-computer-windows.mjs`: một TextContent chứa JSON array một chuỗi (`list[str]`), không phải text snapshot thuần. Parser cũ từ chối trước kiểm tra focus. Fixture cũ gọi renderer Python trực tiếp nên đã bỏ sót bước FastMCP serialize response — kết quả PASS trước đó chưa đủ để xác nhận giao thức desktop thật.

Đã giải mã giới hạn các envelope text đã biết (string hoặc array một string), chuẩn hóa CRLF, giữ ảnh native và vẫn từ chối object/nested array/nhiều snapshot không rõ nghĩa. Thêm fixture FastMCP stdio thật bằng chính runtime cài trong venv: observe có/không ảnh và preflight trước Shortcut giả lập đều PASS; không gửi phím ra desktop trong fixture.

Sau khi mở/focus bản release Audio Wave Studio bằng Computer Use của Codex, adapter dự án đọc được 234 targets, gồm `Mở project`. Hai lần observe ban đầu vẫn khác ở đúng control vùng cuộn `Complementary`: điểm `(939,859)` đổi thành `(760,924)` dù chưa thao tác. Mã nguồn Windows-MCP xác nhận `random_point_within_bounding_box` được dùng cho mỗi lần capture vùng cuộn. Đã thêm bridge tiến trình con, pin 0.8.6, dùng tâm rectangle ổn định. Không chỉnh sửa thư viện đã cài và không nới điều kiện so sánh tọa độ.

Chạy lại chẩn đoán trên Audio Wave Studio thật: **exit 0, 234 targets, `open_project_found=true`, `identity_unchanged=true`, `changed_sections=[]`**. Đây là bằng chứng đọc UI và identity ổn định trên desktop thật, chưa phải bằng chứng click/chọn file/preview/render qua MCP. `npm run test:computer:windows` PASS exit 0 với kiểm tra serializer thật, tâm vùng cuộn ổn định/thay đổi theo geometry, và các guard/refusal đã có. Server/tunnel live chưa restart; cần nạp build mới và mở session Windows mới.

### Đối chiếu bug report Audio Wave Studio 09:28–09:31

Báo cáo nguồn: `D:/MakeClip/AudioWaveStudio/COMPUTER_USE_BUG_REPORT_2026-09-28.md`. Tiến trình server quan sát được khởi động 09:27:08, sau build 09:11; không quy lỗi này cho việc quên restart. Chưa có cặp snapshot của các observation ID trong báo cáo nên chưa kết luận field gây `UI_CHANGED` trong phiên ChatGPT đó.

Lệnh tái hiện trong báo cáo dùng `target:"Mở project"`/`target:"Tên video"` trên backend Windows. Adapter yêu cầu `label` từ `windows_targets`; trước đây preflight chạy trước kiểm tra label nên che mất lỗi tham số bằng lỗi focus/tree. Đã sửa thứ tự và metadata công cụ để trả `COMPUTER_TARGET_REQUIRED` trước capture khi dùng sai target. Label không có trong observation trả `COMPUTER_TARGET_NOT_FOUND`.

Thêm `ComputerUiError` và response có `data.code`, diagnostics giới hạn/redacted, `adapter_revision`. Pin handle trong session sau lần observe hợp lệ đầu; cửa sổ cùng title nhưng handle khác không tự rebind. Cây chỉ có nút khung cửa sổ trả `COMPUTER_TREE_NOT_READY`, không cấp token. Không khẳng định đã có detector WebView load hoàn chỉnh: trạng thái `web_content_ready=unknown`. Không bỏ full app-tree guard vì chưa có chứng cứ cho phép bỏ các field khác. Chưa hỗ trợ PID/owner-modal metadata hoặc tự reauthorize; đóng/mở session vẫn là bước đổi cửa sổ rõ ràng.

`npm run test:computer:windows`: PASS, gồm serializer FastMCP thật, typed errors, redaction, bad-target-before-preflight, frame-only không cấp token, thay handle không rebind, không gửi input khi UI đổi. `CU_TEST_WINDOWS_PROTOCOL=true node scripts/test-computer-use.mjs`: PASS exit 0, kiểm tra lỗi Windows qua HTTP dispatch thật bằng server/control directory cô lập; phần Windows chỉ handshake/schema và lỗi tham số, không capture/click desktop. Bộ browser đối chứng vẫn chạy Chrome thật. `npm test`: PASS exit 0. Build và Windows suite chạy lại sau bổ sung revision vào session status cũng PASS. `git diff --check`: PASS.

Lượt native local trước đó đã xác nhận một click qua adapter mở hộp chọn project; bài test sau đó thất bại vì giả định hộp thoại đổi title (upstream giữ title cha). Khi sửa bài test và thử lại, người dùng nhấn Escape dừng Computer Use; lượt observe tiếp theo bị FORMAT. Không ghi toàn bộ native suite PASS, không coi đây là nghiệm thu connector ChatGPT. Lượt xử lý báo cáo này không dùng Computer Use của Codex hoặc connector thay thế để thao tác desktop, không restart server live và không sửa báo cáo QA/media của Audio Wave Studio.

## CU-06 và CU-07 — timeout sau Type và desktop/Windows Search mất phản hồi

Người dùng báo trên revision `windows-2026-09-28-diagnostics-1`: sau `Type(label=11)` chưa xác định input thực thi hay chưa, hai lần observe `McpError -32001`, đóng/mở session không chữa; đồng thời desktop không kéo được cửa sổ và Windows Search không tương tác được. Đây là hai triệu chứng được gộp kiểm tra nhưng chưa có dump UIA/trace hệ điều hành để xác định cùng một nguyên nhân.

Rà soát Windows-MCP 0.8.6 tại private runtime phát hiện `Desktop.get_state(use_ui_tree=True)` quét cả foreground và các cửa sổ khác (kể cả taskbar/Explorer), còn `SendKeys` có thể đi qua chuỗi Ctrl+A/Backspace/Ctrl+V. SDK timeout không tự chứng minh Python COM/UIA đã kết thúc. Upstream cũng có overlay cửa sổ topmost khi chụp ảnh. Không khẳng định riêng cơ chế nào gây treo thực tế.

Revision `windows-2026-09-28-recovery-2` thay đổi chỉ trong phiên Windows: bridge pin version giới hạn lấy handle UIA vào foreground root, không quét các cửa sổ nền; tắt flash overlay, đặt tree budget 350 và thời hạn 12 giây cho một lời gọi upstream. Khi lời gọi ném lỗi/mất phản hồi, thu hồi session và đóng chính child trước khi giải phóng lease, nếu cleanup lỗi giữ revoked lease. Đối với action, ghi `request_id`, `status=unknown`, `action_completed=null`, không tự replay. `computer_session(status)` cho xem receipt 10 phút theo task/conversation kể cả session đã đóng, không chứa giá trị đã gõ. ACK từ backend không được nâng thành PASS trên UI.

Kiểm thử sau sửa: `npm run test:computer:windows` **PASS exit 0**, xác minh renderer/stdio thật bằng dữ liệu giả lập, scoping foreground bằng Win32 mock, kết quả ACK không đồng nghĩa xác minh UI, lost-response quarantine và receipt còn sau close, isolation giữa conversation, timeout observe dừng child và nhả lease. Không hề chụp hoặc nhập vào desktop người dùng. `npm run test:computer` **PASS exit 0** trên fixture Chrome thật, gồm 20 click, unknown action, Stop, upload, restart và task isolation. Bản sửa chưa được load vào server live; chưa chạy native test Audio Wave Studio vì người dùng báo mất quyền điều khiển desktop. Windows drag/Search chưa được kiểm chứng phục hồi tại thời điểm ghi nhận. Xem hướng dẫn xử lý tại `docs/computer-use.md`.

## Browser dùng chung workspace + task — sửa `COMPUTER_BUSY`

Trước sửa, `openComputerSession` chặn mọi browser session thứ hai có cùng `taskId/backend`, khiến chat thứ hai không sử dụng được browser đang mở dù cùng task. Browser dashboard setup cũng phải đóng trước khi ChatGPT dùng lại profile. Không có nhu cầu phân chia task/workspace chỉ để vượt khóa này.

Đã chuyển thành một session/backend mỗi task trong cùng execution workspace và Workbench server; `open` thứ hai **join session hiện hữu**, `open` song song chờ cùng một lời gọi khởi tạo. Mỗi conversation phải được gán đúng task và còn machine scope rồi tự `open`; không tự dùng được session chỉ bằng ID. Hàng đợi browser tuần tự hóa observe/action/upload; observation riêng theo conversation, action invalidates tất cả observation cũ. Chooser chỉ do chat mở được upload. `computer_session(close)` detach chat, backend chỉ đóng khi chat cuối rời hoặc Dashboard Stop/thu hồi task. Một lệnh `open` từ ChatGPT khi dashboard setup vẫn mở chuyển cùng browser sang automation, không spawn Chrome thứ hai.

**Kiểm thử trên fixture:**

- `npm run test:computer` PASS exit 0: qua HTTP thật, chat A/B cùng task nhận cùng session ID, join idempotent, B không được dùng trước join, B chỉ observe không hủy token của A, action của A/B hủy token cũ của bên kia; B detach không đóng Chrome của A; chooser thuộc A thì B không đọc/chiếm upload.
- Hai `open` thực sự đến đồng thời qua adapter chạy trên Chrome headless chỉ tạo một child/profile/lease; hai observe song song được tuần tự; khi A detach, B tiếp tục observe; đã kiểm thử chuyển `manual` → automation trên cùng backend bằng mô phỏng trạng thái setup (không mở cửa sổ headed trên desktop đang có lỗi native).
- Task khác vẫn dùng profile riêng; permission/Basic writer, Stop/fault/restart, 20 click và no-replay vẫn PASS. `npm run test:computer:windows`, `npm run test:multimodal`, `npm test` PASS exit 0.

Giới hạn: chia sẻ ở **cùng Workbench server**; lease của tiến trình Workbench khác vẫn bị từ chối để tránh hai browser cùng ghi một profile. Dashboard setup headed thật và sự tương tác bằng chính phiên ChatGPT web sau restart live chưa được nghiệm thu trong lượt này. Không restart server, không sửa `.env`, không commit/push các file đang có thay đổi của những phiên khác.

## Mở rộng: một browser toàn Workbench, kể cả workspace/task khác nhau

Theo yêu cầu tiếp theo, bỏ chia profile/session theo task. `computer_session(open,backend=browser)` cấp membership theo bộ ba **task ID + execution workspace + conversation owner**, nhưng mọi membership trỏ tới cùng browser MCP, Chrome và profile `profiles/workbench-shared-browser`. Các lệnh đi qua một hàng đợi; mỗi membership có observation riêng, action vô hiệu token toàn browser. Hai `open` đến cùng lúc chỉ tạo một child. Task bị đổi policy, chuyển writer hoặc thu hồi quyền sẽ chỉ bị tách khỏi browser; task khác vẫn tiếp tục. Một session chỉ đóng khi member cuối rời, lease hết hạn hoặc Dashboard Stop. Windows native vẫn giữ lease riêng/exclusive.

Job/evidence vẫn lưu theo task và poll/cancel theo owner; upload vẫn qua `validatePath` theo chính context task gọi lệnh. Cookie, tab và trạng thái trang **cố ý chia sẻ**, nên browser không còn là ranh giới giữa các project. Nếu chooser của task bị thu hồi quyền còn mở, không cho task khác chiếm upload; cần Dashboard Stop để giải quyết. Dữ liệu profile cũ theo task không bị xóa/đọc hoặc tự nhập sang profile chung, cần tự đăng nhập lại.

Kiểm thử `npm run test:computer` PASS exit 0: cùng task và hai task trong một workspace nhận cùng session ID qua dispatch HTTP; Chrome thật chứng thực hai execution workspace khác nhau dùng cùng profile/cookie/session; cùng owner string khác task không được mượn membership; thu hồi task đầu vẫn giữ session hoạt động cho workspace thứ hai; mở đồng thời, detach, chooser, restart/Stop và timeout vẫn có test. Dashboard setup headed thật và ChatGPT web sau server restart chưa nghiệm thu, không thay đổi server live trong lần này.

Kiểm thử bổ sung sau sửa: `npm run test:computer:windows`, `npm run test:multimodal`, `npm test`, `node --check public/ui/computer-use.js` và `git diff --check` đều PASS exit 0. Các cảnh báo LF→CRLF của Git không phải test failure. Chưa commit/push và không tự dọn các file untracked thuộc phiên khác.

## Chuẩn hóa một Chrome và dùng lại profile đã lưu — 2026-09-28

Chủ máy xác nhận chia sẻ một Chrome cho tất cả workspace/task. Bổ sung `COMPUTER_BROWSER_PROFILE_PATH` (đường dẫn tuyệt đối tới user-data) để dùng trực tiếp profile cũ, không tạo profile rỗng hoặc copy cookie. `.env` local chọn profile của task `d8b154d1-a915-442c-8216-824a7f1da699` trong ảnh người dùng; đã đối chiếu SHA-256 của task ID và sự tồn tại của `Default/Preferences`. Không đọc nội dung cookie hoặc xác nhận trạng thái đăng nhập của các dịch vụ thật.

Dashboard trả `shared_profile` và hiển thị đường dẫn khi chưa mở phiên. Task dropdown chỉ chọn quyền mở Chrome. Sửa `assertControlIdle` kiểm tra membership thật thay vì controller đại diện; regression HTTP xác nhận controller phụ ở task khác cũng nhận `CONTROL_BUSY` trước khi rời phiên.

`npm run test:computer` PASS exit 0: đường dẫn cấu hình được dùng qua approval/HTTP/dashboard, đường dẫn tương đối bị từ chối, cookie/localStorage giữ qua reopen và chia sẻ sang task/workspace khác, mở đồng thời chỉ tạo một browser. `node --check public/ui/computer-use.js` và `git diff --check` PASS. Các fixture dùng thư mục tạm riêng, không mở profile thật; server live chưa restart để nạp code và `.env` mới.
