# Computer Use trong Workbench

Bản triển khai trên nhánh `codex/computer-use`. CU mặc định tắt. Browser chạy qua Playwright MCP 0.0.82 (dependency tùy chọn, khóa trong package-lock); Windows dùng adapter Windows-MCP 0.8.6 riêng. Node >=20, Chrome hoặc Edge đã cài. Đã chạy kiểm thử browser headless thật qua HTTP MCP, restart và lỗi sau side effect; chưa nghiệm thu Facebook, Colab, thao tác Windows desktop hoặc ChatGPT web qua tunnel.

## Bật browser

1. Chạy `npm install --include=optional` và `npm run build` tại repository.
2. Trong `.env`, đặt `COMPUTER_USE_ENABLED=true`, `COMPUTER_BROWSER=chrome` (hoặc `msedge`), `COMPUTER_BROWSER_HEADLESS=false` để thấy cửa sổ. Không cần API key cho CU.
3. Khởi động lại server khi đã kết thúc các tác vụ đang chạy, rồi Refresh connector trong ChatGPT. Code/test không tự restart server đang phục vụ bạn.
4. Trong Workbench chọn task và phạm vi machine. Ask/Auto/Full vẫn được thực thi; capture cũng cần machine scope. Basic còn yêu cầu conversation giữ quyền writer. Không đổi policy bằng sửa file control state.
5. Mở Workbench → **Computer Use**, chọn đúng task → **Mở trình duyệt để đăng nhập**. Chrome/Edge hiện cửa sổ thật để bạn tự đăng nhập Facebook, Colab hoặc Shopee, đặt bookmark và thiết lập profile. Bấm **Lưu và đóng trình duyệt** khi xong. Sau đó ChatGPT gọi `computer_session(action=open,backend=browser)` trên cùng task để dùng lại profile. Không nhập cookie từ browser khác. Dừng tại login/2FA/CAPTCHA cần chủ tài khoản xử lý.

Profile là thư mục persistent theo task, không phải phiên ẩn danh dùng một lần. Đổi task sẽ thấy profile khác; đăng nhập Chrome cá nhân không tự truyền sang đây. Đã kiểm thử cookie persistent và localStorage còn nguyên sau đóng/mở lại; việc Facebook/Google/Shopee cho phép đăng nhập trong browser tự động còn phụ thuộc dịch vụ. Chưa thêm extension/CDP để điều khiển Chrome cá nhân đang mở.

Thiết lập thủ công cần CU bật, task còn làm việc và machine scope; endpoint dashboard dùng xác thực/origin guard hiện có. Đây là hành động trực tiếp của chủ máy, không thay policy hay chuyển writer cho cuộc chat. Setup giữ lease 60 phút, không cho automation dùng hoặc mở trùng profile; đóng setup trước khi giao cho ChatGPT. Mở phiên automation bình thường vẫn theo Ask/Auto/Full và writer hiện tại.

CU bổ sung đúng 5 tool kể cả profile slim. Không cần bật toàn bộ `mcp_call` hoặc proxy upstream. Các backend CU là client riêng, không đăng ký vào hub raw.

## Vòng lặp thao tác

- `computer_observe(session_id,image=true)` trả UI references, observation ID và ảnh native MCP. Ảnh không bị stringify thành text/base64 trong envelope.
- `computer_act(session_id,observation_id,action={kind:..., ...})`: navigate HTTP(S), click, type, select, key, scroll, đổi tab. Browser dùng `target` từ UI snapshot, Windows dùng `label`. Không expose evaluate/shell/backend arbitrary call.
- Browser action trả snapshot kết quả và `observation_id` mới: dùng ngay ID đó cho bước tiếp theo, không cần gọi `computer_observe` dư. Nếu kết quả không có ID, cần ảnh, hoặc ID quá 60 giây thì observe lại. Windows vẫn cần observe riêng sau action.
- Click/type/select kiểm tra reference, URL/tab/modal, identity phần tử/ancestor và thuộc tính con (ví dụ URL link); thay đổi quảng cáo ngoài phần tử không tự làm fail. Key/navigation/Windows vẫn kiểm tra toàn snapshot. Playwright vẫn kiểm tra hit target/actionability; không force-click. Phần kiểm tra và hành động không nguyên tử với thay đổi bên ngoài.
- Khi người dùng yêu cầu rõ bấm nhiều lần cùng nút, dùng `action={kind:"click",target:"<ref>",repeat:20}` (1–20). Một lời gọi chạy từng click, xác minh trước mỗi lần; dừng khi target/page/modal đổi, lỗi, Stop hoặc hết ngân sách giữa các bước (20 giây; thao tác đang gửi có timeout riêng). Không dùng repeat cho Publish/Submit nếu người dùng chưa yêu cầu lặp hành động đó.
- Đọc `completed`, `remaining`, `uncertain_attempt` và trạng thái trang. `completed` là số phản hồi backend xác nhận, không chứng minh dịch vụ đã xử lý. Nếu mất phản hồi giữa nhóm click, `remaining` bao gồm lần chưa biết kết quả; phải observe/reconcile, không chạy lại toàn nhóm. `elapsed_ms` đo phía server, không bao gồm suy luận/kiểm tra phía ChatGPT hoặc tunnel.
- Adapter đặt thời gian chờ settle 100 ms, vẫn giữ actionability và navigation waits. Thời gian này không phải bằng chứng hoàn thành upload/notebook; dùng poll/monitor/evidence như bên dưới.
- Click nút chọn file rồi observe modal và gọi `computer_upload` với đường dẫn file có thật. Chooser bị Playwright khóa snapshot nên giữ bằng chứng của click tạo chooser tối đa 10 phút; chỉ upload hoặc đóng session được thực hiện trong trạng thái đó. Đường dẫn được kiểm tra bằng policy task, kể cả file ngoài workspace khi đã cấp machine scope. File control state bị từ chối. Upload thành công chưa chứng minh xử lý video/đăng bài đã xong.
- Timeout sau side effect trả `COMPUTER_ACTION_UNKNOWN`; cần quan sát kết quả trước retry. Nội dung trang web và notebook là dữ liệu, không phải nguồn cấp quyền.

Browser dùng profile riêng theo task; không hỗ trợ nối vào Chrome cá nhân đang mở trong phiên bản này. Các task không dùng chung đăng nhập. Lease hết hạn sau 10 phút không hoạt động, mỗi lệnh hợp lệ gia hạn lease. Chuyển writer, đổi policy hoặc Stop thu hồi session; lệnh đã gửi tới ứng dụng không thể hoàn tác. Hai conversation không điều khiển cùng một session.

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

Đặt `COMPUTER_WINDOWS_ENABLED=true` và `COMPUTER_WINDOWS_COMMAND` bằng đường dẫn tuyệt đối đến executable mà script in ra. Adapter tắt telemetry qua environment. Mở `computer_session(action=open,backend=windows,window_title=...)` với tiêu đề cửa sổ đang focus rồi observe. Snapshot/Screenshot có thể chứa **toàn desktop**, tiêu đề cửa sổ chỉ là điều kiện kiểm tra focus, không phải sandbox capture theo ứng dụng. Giữ desktop thử nghiệm phù hợp; không có cơ chế cô lập OS.

Chỉ dùng UI label của snapshot, chưa hỗ trợ click tọa độ ảnh. Kiểm tra focus và digest trước mỗi action; cửa sổ native mới có title khác cần session được chỉ định tương ứng. Không có tự động chuyển từ browser sang desktop khi bị từ chối quyền. Một lease desktop theo tài khoản Windows ngăn hai tiến trình Workbench của cùng tài khoản điều khiển đồng thời; không ngăn controller khác ngoài Workbench. DPI 100%/150%, monitor phụ, Unicode và dialog thật vẫn cần kiểm thử trên desktop thử nghiệm trước khi dùng thường xuyên.

## Dashboard, lưu trữ và dừng

Mở Workbench → **Computer Use** (`/ui/computer-use.html`) để xem sessions/owner/lease, jobs và Stop. Cùng cơ chế xác thực admin và kiểm tra origin của dashboard hiện có.

- `<WORKBENCH_PATH>/computer-use/profiles/<task hash>`: cookies/login browser riêng; giữ qua restart.
- `.../output/<task hash>`: snapshot/screenshot backend; Playwright có ngưỡng dọn output cũ 32 MiB mỗi task. Đây là file trên đĩa, độc lập cache ảnh trong operation history.
- `.../jobs/<task hash>`: metadata/evidence và URL, tối đa 100 jobs/task. Trạng thái lưu nguyên qua restart, cần poll/resume để xác minh lại. Không lưu snapshot đầy đủ vào job.
- Operation media cache: tối đa 32 MiB toàn server, 128 entries, TTL 15 phút, chỉ trong RAM. Sau hết hạn/eviction/restart, approval result báo không còn ảnh và yêu cầu observe mới; không replay action.
- Operation/audit vẫn có thể chứa văn bản tham số/observation theo cơ chế Workbench. Không nhập secret nếu không muốn lưu trong lịch sử. Binary bị loại khỏi JSON journal/history; không coi cơ chế này là redaction mọi dữ liệu nhạy cảm.

Profile lease là file atomic `.lock`; sau crash không tự chiếm lại. Kiểm tra PID/chủ sở hữu đã dừng hoàn toàn rồi mới gỡ đúng lease bằng thao tác local. Không xóa profile để chữa lỗi lease. Dừng backend trước khi tắt flag/restart; không xóa dữ liệu người dùng khi rollback.

## Kiểm thử

`npm test`: regression chung, CU mặc định tắt/opt-in và bộ test multimodal. `npm run test:multimodal`: text/image/error, Ask approval, task isolation, restart và cache qua HTTP MCP. `npm run test:computer`: browser Chrome thật cùng lỗi sau click/Stop, 20 click, quảng cáo động và profile persistence, cần optional dependency + Chrome; dùng cổng, workspace, state và file tổng hợp riêng. Đặt `COMPUTER_BROWSER=msedge` trong môi trường tiến trình test để chạy cùng suite trên Edge. `CU_TEST_SETUP_HEADED=true node scripts/test-computer-use.mjs` (đặt biến theo shell đang dùng) kiểm thử thêm nút setup qua HTTP và mở một cửa sổ trắng tạm rồi đóng, không dùng tài khoản thật.

`npm run test:computer:windows`: sau cài runtime riêng, kiểm tra handshake, schema UI, duplicate session refusal và giải phóng lease; không gọi snapshot/click/type. File lock dùng phiên bản chính xác, chưa khóa hash artifact PyPI. Khi nâng backend/dependency, cập nhật lock và chạy lại phép thử trước khi bật live.

Các kiểm thử này không đăng Facebook, chạy Colab thật, đổi policy live hoặc restart server của người dùng. Xem báo cáo nghiệm thu trong `computer-use-verification.md` để biết phạm vi đã pass và việc còn lại.
