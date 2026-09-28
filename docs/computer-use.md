# Computer Use trong Workbench

Bản triển khai trên nhánh `codex/computer-use`. CU mặc định tắt. Browser chạy qua Playwright MCP 0.0.82 (dependency tùy chọn, khóa trong package-lock); Windows dùng adapter Windows-MCP 0.8.6 riêng. Node >=20, Chrome hoặc Edge đã cài. Đã chạy kiểm thử browser headless thật qua HTTP MCP, restart và lỗi sau side effect; chưa nghiệm thu Facebook, Colab, thao tác Windows desktop hoặc ChatGPT web qua tunnel.

## Bật browser

1. Chạy `npm install --include=optional` và `npm run build` tại repository.
2. Trong `.env`, đặt `COMPUTER_USE_ENABLED=true`, `COMPUTER_BROWSER=chrome` (hoặc `msedge`), `COMPUTER_BROWSER_HEADLESS=false` để thấy cửa sổ. Không cần API key cho CU.
3. Khởi động lại server khi đã kết thúc các tác vụ đang chạy, rồi Refresh connector trong ChatGPT. Code/test không tự restart server đang phục vụ bạn.
4. Trong Workbench chọn task và phạm vi machine. Ask/Auto/Full vẫn được thực thi; capture cũng cần machine scope. Basic còn yêu cầu conversation giữ quyền writer. Không đổi policy bằng sửa file control state.
5. Mở Workbench → **Computer Use**, chọn đúng task → **Mở trình duyệt để đăng nhập**. Chrome/Edge hiện cửa sổ thật để bạn tự đăng nhập Facebook, Colab hoặc Shopee. Khi sẵn sàng, ChatGPT gọi `computer_session(action=open,backend=browser)` trong đúng workspace/task để **gắn vào cửa sổ đang mở**, không cần đóng rồi mở lại. Bạn vẫn có thể bấm **Lưu và đóng trình duyệt** nếu muốn kết thúc phiên thiết lập; lần sau giữ lại profile/cookie. Không nhập cookie từ browser khác. Dừng tại login/2FA/CAPTCHA cần chủ tài khoản xử lý.

Profile là thư mục persistent **toàn Workbench**, không phải phiên ẩn danh dùng một lần. Các workspace/task được cấp quyền chia sẻ cùng cookie, đăng nhập, tab và lịch sử trang. Browser này không tự nhận đăng nhập từ Chrome cá nhân; chưa thêm extension/CDP để điều khiển Chrome cá nhân đang mở.

Để giữ Chrome Workbench đã lưu, đặt `COMPUTER_BROWSER_PROFILE_PATH` trong `.env` thành đường dẫn tuyệt đối tới **thư mục user-data cũ** (thư mục cha của `Default`). Server dùng trực tiếp thư mục đó cho mọi task/workspace, không copy hay nhập cookie và không tự đổi profile khi đổi task. Bỏ trống dùng `computer-use/profiles/workbench-shared-browser`. Dashboard hiển thị đường dẫn đã chọn ngay cả khi chưa mở phiên; dropdown task chỉ chọn thẩm quyền mở browser. Thay cấu hình khi các phiên đã đóng, sau đó restart server. Khóa profile hiện có vẫn được tôn trọng.

Thiết lập thủ công cần CU bật, task còn làm việc và machine scope; endpoint dashboard dùng xác thực/origin guard hiện có. Đây là hành động trực tiếp của chủ máy, không thay policy hay chuyển writer cho cuộc chat. Setup giữ lease 60 phút nếu chưa có automation. Lần `open` được cấp quyền từ ChatGPT chuyển chính session trình duyệt đang mở sang automation; không tạo Chrome thứ hai hoặc thay quyền. Mở phiên automation vẫn theo Ask/Auto/Full và writer hiện tại.

CU bổ sung đúng 5 tool kể cả profile slim. Không cần bật toàn bộ `mcp_call` hoặc proxy upstream. Các backend CU là client riêng, không đăng ký vào hub raw.

## Vòng lặp thao tác

Khi phiên Windows còn mở, các lời gọi Chrome có cửa sổ tạm dừng với `COMPUTER_DESKTOP_BUSY`; monitor browser cũng tạm ngừng quan sát để tránh tranh foreground. Profile/tab được giữ nguyên, đóng phiên Windows để tiếp tục browser. Người dùng hoặc ứng dụng khác vẫn có thể đổi focus. Nếu gặp `COMPUTER_WINDOW_CHANGED`, không lặp click cũ: chọn lại cửa sổ đích rồi lấy observation mới trong lượt phục hồi được phép. Xem [phân tích và kiểm thử focus](computer-use-focus-recovery.md).

- `computer_observe(session_id,image=true)` trả UI references, observation ID và ảnh native MCP. Ảnh không bị stringify thành text/base64 trong envelope.
- `computer_act(session_id,observation_id,action={kind:..., ...})`: navigate HTTP(S), click, type, select, key, scroll, đổi tab. Browser dùng `target` từ UI snapshot, Windows dùng `label`. Không expose evaluate/shell/backend arbitrary call.
- Browser action trả snapshot kết quả và `observation_id` mới: dùng ngay ID đó cho bước tiếp theo, không cần gọi `computer_observe` dư. Nếu kết quả không có ID, cần ảnh, hoặc ID quá 60 giây thì observe lại. Windows vẫn cần observe riêng sau action.
- Click/type/select kiểm tra reference, URL/tab/modal, identity phần tử/ancestor và thuộc tính con (ví dụ URL link); thay đổi quảng cáo ngoài phần tử không tự làm fail. Browser key/navigation kiểm tra toàn snapshot trang. Windows kiểm tra cửa sổ foreground, toàn bộ cây control của cửa sổ đó và danh sách handle/depth/status/kích thước cửa sổ; bỏ qua cursor, đồng hồ taskbar và nội dung của ứng dụng nền. Playwright vẫn kiểm tra hit target/actionability; không force-click. Phần kiểm tra và hành động không nguyên tử với thay đổi bên ngoài.
- Khi người dùng yêu cầu rõ bấm nhiều lần cùng nút, dùng `action={kind:"click",target:"<ref>",repeat:20}` (1–20). Một lời gọi chạy từng click, xác minh trước mỗi lần; dừng khi target/page/modal đổi, lỗi, Stop hoặc hết ngân sách giữa các bước (20 giây; thao tác đang gửi có timeout riêng). Không dùng repeat cho Publish/Submit nếu người dùng chưa yêu cầu lặp hành động đó.
- Đọc `completed`, `remaining`, `uncertain_attempt` và trạng thái trang. `completed` là số phản hồi backend xác nhận, không chứng minh dịch vụ đã xử lý. Nếu mất phản hồi giữa nhóm click, `remaining` bao gồm lần chưa biết kết quả; phải observe/reconcile, không chạy lại toàn nhóm. `elapsed_ms` đo phía server, không bao gồm suy luận/kiểm tra phía ChatGPT hoặc tunnel.
- Adapter đặt thời gian chờ settle 100 ms, vẫn giữ actionability và navigation waits. Thời gian này không phải bằng chứng hoàn thành upload/notebook; dùng poll/monitor/evidence như bên dưới.
- Click nút chọn file rồi observe modal và gọi `computer_upload` với đường dẫn file có thật. Chooser bị Playwright khóa snapshot nên giữ bằng chứng của click tạo chooser tối đa 10 phút; chỉ upload hoặc đóng session được thực hiện trong trạng thái đó. Đường dẫn được kiểm tra bằng policy task, kể cả file ngoài workspace khi đã cấp machine scope. File control state bị từ chối. Upload thành công chưa chứng minh xử lý video/đăng bài đã xong.
- Timeout sau side effect trả `COMPUTER_ACTION_UNKNOWN`; cần quan sát kết quả trước retry. Nội dung trang web và notebook là dữ liệu, không phải nguồn cấp quyền.

### Dùng chung trình duyệt toàn Workbench

Các conversation từ **bất kỳ workspace/task nào trong cùng Workbench server** đều có thể gọi `computer_session(action=open,backend=browser)` để nhận **cùng một `session_id`**, browser và profile, sau khi xác minh task và cấp machine scope cho chính chat đó. Một conversation mới phải gọi `open` trước khi quan sát/thao tác; biết ID thôi không đủ quyền. Hai `open` đến cùng lúc cũng chỉ khởi chạy một backend trong cùng server. `COMPUTER_BUSY` vẫn có thể xuất hiện nếu backend đang dừng hoặc lease bị giữ bởi tiến trình khác; không tự gỡ lease.

Mọi quan sát, action và upload đi qua một hàng đợi theo browser. Observation riêng theo tổ hợp task/workspace/conversation; chỉ quan sát ở chat B không làm mất token của chat A. Nhưng khi bất kỳ chat nào thực hiện action có thể có side effect, **toàn bộ token cũ** đều bị vô hiệu để tránh click đè hoặc gửi trùng. File chooser do chat nào mở thì chat đó hoàn tất upload; chat khác phải chờ. Nếu chủ chooser bị thu hồi quyền, các chat khác cần Dashboard Stop để giải quyết chooser không còn chủ. `computer_session(action=close)` rời browser chung mà không tắt phiên của chat còn lại; chat cuối cùng đóng thì browser tắt. Nút **Stop** của Dashboard dừng toàn bộ browser dùng chung.

**Phạm vi chia sẻ:** cùng Workbench server, kể cả các workspace/task khác nhau. Mọi chat được cấp quyền đều thấy cùng trang, tab và phiên đăng nhập; không coi browser là ranh giới bảo mật giữa project. File upload tiếp tục kiểm tra policy của task gọi lệnh; job vẫn lưu theo task và thao tác poll/cancel chỉ do chủ job thực hiện. Không làm bridge đến Chrome cá nhân hoặc tiến trình Workbench server khác.

Lease browser hết hạn sau 10 phút không hoạt động, mỗi lệnh hợp lệ gia hạn lease. Chuyển writer/đổi policy thu hồi **thành viên của task tương ứng** mà không đóng browser của task khác; Dashboard Stop dừng tất cả. Lệnh đã gửi tới ứng dụng không thể hoàn tác. Hai conversation từ bất kỳ task nào dùng hàng đợi chung, không cùng lúc phát lệnh tới backend.

## Theo dõi Facebook / Colab

Đọc `computer_job(action=guide,workflow=facebook|colab)` trước thao tác. Đây là hướng dẫn kết hợp UI tools; chưa có bot hardcode selector hoặc bảo đảm hoàn thành mọi giao diện Facebook/Colab.

`create` nhận `session_id`, `workflow`, `expected_url`, `success_text` (1–4 dấu hiệu riêng), tùy chọn `failure_text`, `input_text`, `artifact_text`. Nó lưu job, không tự click Run/Publish. UUID job phân biệt lần theo dõi; không phải ID bài đăng Facebook hoặc bảo đảm chống trùng phía dịch vụ.

`poll` quan sát một lần có timeout. `monitor` chạy worker chỉ đọc, backoff từ 2 đến 15 giây, tối đa `duration_seconds=600`; dừng khi chờ input, thành công, lỗi, disconnect, đổi URL/unknown hoặc hết thời hạn. Worker không tự quyết định hay điền input. `status`/`list` và dashboard đọc tiến độ. Monitor không tự bật lại sau restart, không gọi LLM, không đánh thức hoặc gửi thông báo cho ChatGPT khi chat đóng.

Thành công chỉ là **các dấu hiệu đã cấu hình cùng xuất hiện trong snapshot của đúng URL**. Không dùng chuỗi đã có sẵn trong code cell, caption, nút bấm, lịch sử output hoặc trang tĩnh làm bằng chứng. Chọn token duy nhất theo lần chạy, kiểm tra đúng cell/item và artifact; trang giả mạo hoặc cấu hình dấu hiệu sai vẫn có thể làm phép so khớp sai. Tool không xác minh bytes của file đầu ra hay trạng thái Facebook bằng API.

Facebook: xác minh account/đích, media preview, nội dung, ngày giờ và timezone. Chỉ click Publish/Schedule trong phạm vi người dùng đã giao. Sau đó xem đúng item Published/Scheduled để đối chiếu media/nội dung/lịch và lấy URL/ID nếu có. Khi timeout phải kiểm tra item tồn tại trước retry. Chưa có yêu cầu đăng bài cụ thể trong lần triển khai này.

Colab: đối chiếu notebook/tool/cell, không mặc định Run all. Phân biệt file local, Drive picker và đường dẫn runtime. Khi `waiting_input`, observe rồi điền input được cấp; tiếp tục poll/monitor. Chỉ ngừng spinner không chứng minh thành công. Notebook thử ở `docs/fixtures/computer-use-colab.ipynb` tạo token từng lượt, nhận file/text, mô phỏng lỗi và sinh artifact; chưa được chạy trên Colab thực tế.

Khi mất phiên, mở session mới và `resume(job_id,session_id)` rồi poll để đối chiếu. Không tự chạy lại thao tác trước. Job terminal không resume. `cancel` và Stop chỉ dừng điều khiển; Colab remote có thể còn chạy. Nếu đóng backend lỗi, job không bị đánh dấu cancelled, lease được giữ ở trạng thái stopping và có thể thử Stop lại; không báo dừng thành công khi chưa đóng được transport. Muốn interrupt Colab phải quan sát đúng runtime và thao tác riêng trong phạm vi được giao.

## Windows native dialog (chưa nghiệm thu desktop)

Cài riêng khi cần: `powershell -NoProfile -File scripts/setup-computer-windows.ps1`. Cần `uv`; script tạo `.computer-use-runtime/windows`, chọn Python 3.14.7 và sync dependency theo `scripts/computer-windows-requirements.txt` (92 phiên bản chính xác, gồm `windows-mcp==0.8.6`). `-PlanOnly` chỉ in đường dẫn. Không cài package global, không tự sửa `.env`, không chạy elevated. Đã cài và kiểm thử handshake/catalog trên máy này; đây chưa phải nghiệm thu thao tác desktop.

Đặt `COMPUTER_WINDOWS_ENABLED=true` và `COMPUTER_WINDOWS_COMMAND` bằng đường dẫn tuyệt đối đến executable mà script in ra. Adapter tắt telemetry qua environment. Mở `computer_session(action=open,backend=windows,window_title=...)` với tiêu đề cửa sổ đang focus rồi observe. **Ảnh** Snapshot/Screenshot vẫn có thể chứa toàn desktop; UIA tree giới hạn vào foreground root thay vì quét các cửa sổ nền/Explorer/Taskbar. Tiêu đề cửa sổ chỉ là điều kiện kiểm tra focus, không phải sandbox capture theo ứng dụng. Giữ desktop thử nghiệm phù hợp; không có cơ chế cô lập OS.

Windows click/type/scroll bắt buộc dùng `label` trong bảng `windows_targets` của lần observe đó. Adapter tự ánh xạ label sang tọa độ control trong cây UI; không dùng index nội bộ của upstream hoặc tọa độ đo từ ảnh. Windows-MCP 0.8.6 không in các index nội bộ trong semantic tree. Observe có ảnh dùng một `Snapshot(use_vision=true,use_ui_tree=true)`, tránh gọi Screenshot riêng làm xóa tree cache upstream.

Adapter giải mã cả snapshot text thuần và `list[str]` được FastMCP bọc thành JSON trong text block. Backend chạy bằng `python.exe` cùng private venv với `COMPUTER_WINDOWS_COMMAND`, qua `scripts/computer-windows-bridge.py`. Bridge yêu cầu đúng Windows-MCP 0.8.6, thay điểm ngẫu nhiên của vùng cuộn bằng tâm bounding rectangle và chỉ thu thập UIA foreground root; thay đổi chỉ trong tiến trình con, không sửa package đã cài. Child tắt flash overlay topmost và giới hạn số phần tử tree; vẫn giữ kiểm tra tọa độ/UI state. Việc focus sang dialog/title khác sẽ bị controller từ chối, không tự cấp quyền cho cửa sổ mới.

Chẩn đoán local: `node scripts/diagnose-computer-windows.mjs "Exact window title"` đọc hai snapshot, báo số targets và phần identity thay đổi; không click/nhập phím. Raw response có thể chứa text desktop, lưu đè hai file cố định trong `.computer-use-runtime/windows-observation*.json` bị Git ignore. Cần cửa sổ đích ở foreground và không có session khác giữ lease.

Kiểm tra title chính xác, handle, cây control (gồm focus/value/tọa độ), desktop và bố cục cửa sổ trước mỗi action. Cửa sổ native mới có title khác cần session được chỉ định tương ứng. Snapshot thiếu/khác định dạng hoặc bị cắt sẽ bị từ chối. Không có tự động chuyển từ browser sang desktop khi bị từ chối quyền. Một lease desktop theo tài khoản Windows ngăn hai tiến trình Workbench của cùng tài khoản điều khiển đồng thời; không ngăn controller khác ngoài Workbench. DPI 100%/150%, monitor phụ, Unicode và dialog thật vẫn cần kiểm thử trên desktop thử nghiệm trước khi dùng thường xuyên.

Phiên Windows pin handle upstream ở lần observe có control ứng dụng đầu tiên. Observe sau không tự đổi sang cửa sổ khác dù cùng title: phải đóng/mở session nếu ứng dụng đã được thay thế. `windows_state.readiness` báo `controls_available`; chỉ có các nút khung cửa sổ thì trả `COMPUTER_TREE_NOT_READY` và không cấp observation ID. Đây là kiểm tra cây control, không khẳng định WebView đã tải xong: `web_content_ready` hiện là `unknown`.

Windows click/type/scroll gửi `target:"Mở project"` là sai schema backend; phải gửi `label` số lấy từ `windows_targets`. Lỗi này được phát hiện trước preflight. `computer_observe`/`computer_act` trả `data.code`, `data.diagnostics`, `adapter_revision` cho các lỗi UI đã phân loại. `COMPUTER_UI_CHANGED` kèm `changed_sections`, số/dòng control thay đổi, handle trước/sau, tuổi observation và `action_sent:false`; không kèm giá trị ô nhập. `COMPUTER_OBSERVE_FORMAT` có reason riêng cho missing sections, bảng cửa sổ, tree trống/truncated/không khớp. Lỗi focus có expected/current title và handle; title là dữ liệu UI không đáng tin cậy. Upstream chưa cung cấp PID trong snapshot này; không suy đoán PID hoặc `WINDOW_GONE` từ một lần mất focus. Không tự retry action.

### CU-06 / CU-07 — phục hồi Windows khi UIA hoặc desktop bị kẹt

Windows tool có hạn 12 giây phía adapter. Nếu child mất phản hồi, adapter vô hiệu observation, thu hồi session và đóng **đúng child** trước khi giải phóng lease. Nếu đóng thất bại, lease vẫn revoked/giữ lại, không tự mở child thứ hai. `COMPUTER_WINDOWS_TIMEOUT` là lỗi capture chưa gửi action; `COMPUTER_ACTION_UNKNOWN` nghĩa là request action đã gửi tới backend nhưng không xác định OS/UI có thực hiện hay không. Phản hồi gồm `request_id`, `phase`, `elapsed_ms`, `backend_stopped` và `action_completed:null` khi không rõ. Không gửi lại click/type/submit chỉ vì response bị timeout.

`computer_session(action=status)` có `recent_actions` theo đúng task/conversation, giữ trong RAM tối đa 10 phút cả khi session vừa đóng. `dispatched` chưa có acknowledgement; `acknowledged` chỉ là backend xác nhận, **không** chứng minh giá trị đã thay đổi trên UI; `unknown` là kết quả mất phản hồi hoặc backend trả lỗi. Không lưu nội dung đã gõ trong receipt. Sau khi desktop bình thường, mở session mới và đọc lại UI để đối chiếu trước khi quyết định bước tiếp theo.

Nếu cửa sổ không kéo được hoặc Windows Search không phản hồi: dừng thao tác Computer Use và đóng session Windows. Nếu phiên cũ không đóng được, chủ máy có thể dùng **Ctrl+Alt+Del → Task Manager → Details** để kết thúc đúng `python.exe` có command line chứa `scripts\computer-windows-bridge.py`; không kết thúc hàng loạt tiến trình Python/Explorer/ứng dụng đang làm việc. Nếu Windows shell vẫn không phản hồi, chủ máy có thể khởi động lại riêng Windows Explorer qua Task Manager sau khi lưu công việc. Bản sửa chỉ có hiệu lực sau khi server chạy mã mới; không chạy kiểm thử native tự động trên desktop đang bị kẹt. Đây là biện pháp giảm phạm vi ảnh hưởng và phục hồi, chưa phải chứng minh nguyên nhân gốc duy nhất của lỗi khóa desktop.

## Dashboard, lưu trữ và dừng

Mở Workbench → **Computer Use** (`/ui/computer-use.html`) để xem sessions/owner/lease, jobs và Stop. Cùng cơ chế xác thực admin và kiểm tra origin của dashboard hiện có.

- `COMPUTER_BROWSER_PROFILE_PATH` hoặc mặc định `<WORKBENCH_PATH>/computer-use/profiles/workbench-shared-browser`: dữ liệu browser chung, giữ qua restart. Nếu cấu hình thư mục cũ, Chrome tiếp tục đọc/ghi trực tiếp profile đó; các profile khác không bị xóa.
- `.../output/workbench-shared-browser`: snapshot/screenshot backend chung; Playwright có ngưỡng dọn output cũ 32 MiB. Đây là file trên đĩa, độc lập cache ảnh trong operation history.
- `.../jobs/<task hash>`: metadata/evidence và URL, tối đa 100 jobs/task. Trạng thái lưu nguyên qua restart, cần poll/resume để xác minh lại. Không lưu snapshot đầy đủ vào job.
- Operation media cache: tối đa 32 MiB toàn server, 128 entries, TTL 15 phút, chỉ trong RAM. Sau hết hạn/eviction/restart, approval result báo không còn ảnh và yêu cầu observe mới; không replay action.
- Operation/audit vẫn có thể chứa văn bản tham số/observation theo cơ chế Workbench. Không nhập secret nếu không muốn lưu trong lịch sử. Binary bị loại khỏi JSON journal/history; không coi cơ chế này là redaction mọi dữ liệu nhạy cảm.

Profile lease là file atomic `.lock`; sau crash không tự chiếm lại. Kiểm tra PID/chủ sở hữu đã dừng hoàn toàn rồi mới gỡ đúng lease bằng thao tác local. Không xóa profile để chữa lỗi lease. Dừng backend trước khi tắt flag/restart; không xóa dữ liệu người dùng khi rollback.

## Kiểm thử

`npm test`: regression chung, CU mặc định tắt/opt-in và bộ test multimodal. `npm run test:multimodal`: text/image/error, Ask approval, task isolation, restart và cache qua HTTP MCP. `npm run test:computer`: browser Chrome thật cùng lỗi sau click/Stop, 20 click, quảng cáo động và profile persistence, cần optional dependency + Chrome; dùng cổng, workspace, state và file tổng hợp riêng. Đặt `COMPUTER_BROWSER=msedge` trong môi trường tiến trình test để chạy cùng suite trên Edge. `CU_TEST_SETUP_HEADED=true node scripts/test-computer-use.mjs` (đặt biến theo shell đang dùng) kiểm thử thêm nút setup qua HTTP và mở một cửa sổ trắng tạm rồi đóng, không dùng tài khoản thật.

`npm run test:computer:windows`: sau cài runtime riêng, kiểm tra handshake, schema UI, scoping foreground, snapshot giao thức bằng fixture, hành động giả lập, timeout/quarantine, receipt sống qua close và giải phóng lease; không chụp desktop thật hoặc gửi click/type thật. File lock dùng phiên bản chính xác, chưa khóa hash artifact PyPI. Kiểm thử tích hợp native opt-in riêng, chỉ chạy khi desktop được chủ máy xác nhận an toàn. Khi nâng backend/dependency, cập nhật lock và chạy lại phép thử trước khi bật live.

Các kiểm thử này không đăng Facebook, chạy Colab thật, đổi policy live hoặc restart server của người dùng. Xem báo cáo nghiệm thu trong `computer-use-verification.md` để biết phạm vi đã pass và việc còn lại.
