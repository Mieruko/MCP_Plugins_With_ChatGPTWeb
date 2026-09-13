# Kế hoạch triển khai cho GPT Web: bàn giao, bộ nhớ và phản hồi MCP

Ngày lập: 2026-09-13.
Project đích: D:/chatgpt-local-coder-workbench.
Trạng thái: kế hoạch để GPT Web triển khai; chưa thực hiện các thay đổi mã bên dưới.

## Mục tiêu

Giúp GPT Web tiếp tục công việc qua nhiều cuộc trò chuyện với trạng thái rõ ràng, luôn thấy ghi chú mới trong ngân sách ngữ cảnh, và giảm lượng lịch sử trả về ở mỗi lần kiểm tra Workbench.

Triển khai tuần tự bốn phần bên dưới. Hoàn thành kiểm thử liên quan của mỗi phần trước khi chuyển phần tiếp theo. Không cần xin xác nhận lại cho sửa code, tài liệu và kiểm thử thuộc kế hoạch đã giao; vẫn tuân thủ các quyết định quyền thực tế của Workbench.

## Bắt đầu đúng project

1. Gọi workbench để đọc task, workspace, execution path, policy và quyền ghi hiện tại. Phải được gắn với project đích hoặc worktree thuộc đúng project đó.
2. Nếu task đang thuộc project khác, báo người dùng chọn đúng project/conversation tại dashboard. Không dùng đường dẫn tuyệt đối hay shell để thực hiện thay đổi dưới task của project khác.
3. Đọc AGENTS.md và các skill workbench-mcp-design, workbench-security-review, workbench-verify trong .agents/skills của project.
4. Kiểm tra Git status/diff. Checkout tại thời điểm lập kế hoạch có nhiều thay đổi chưa commit; giữ nguyên các thay đổi đó, không reset, stash, checkout đè hay tạo commit gom toàn bộ.
5. Đọc lại mã liên quan vì mã có thể đã thay đổi sau khi lập kế hoạch. Dùng inspect_code để gộp đọc/tìm kiếm; thu hẹp range khi truncated.
6. Dùng test server, workspace và control directory tạm riêng. Không restart server/tunnel đang kết nối; không đổi .env hoặc policy live để chạy kiểm thử.

## Các phát hiện làm cơ sở

- src/lib/workbench-tools.ts có task_handoff, nhưng src/lib/tool-profile.ts chưa đưa nó vào SLIM_CHATGPT_TOOLS. Kiểm tra trực tiếp từ TypeScript hiện tại trả slimTools=36, handoffSlim=false, handoffFull=true.
- src/server-factory.ts áp dụng bộ lọc profile trước installWorkbench. task_handoff hiện được đăng ký qua original, cần rà soát riêng đường kiểm tra policy/writer trước khi mở cho slim.
- src/lib/auto-memory.ts thêm ghi chú cuối MEMORY.md nhưng loadAutoMemory đọc 200 dòng đầu, tối đa 25.000 byte theo mặc định.
- workbench không có operation_id hiện trả tối đa 30 operations kèm dữ liệu review, dù người gọi chỉ cần xem task và quyền.
- Đã có batching inspect_code, cursor đọc log, tách SSE khỏi queue POST và kiểm thử liên quan. Giữ những hành vi đó.
- Đây là các phát hiện từ mã tại thời điểm lập kế hoạch; không phải benchmark chất lượng mô hình hay bằng chứng về hạn mức ChatGPT.

## Phần 1 — Bàn giao có thể dùng trong slim, với đúng quyền

### Kết quả cần có

GPT Web lưu được bản bàn giao của task hiện tại; cuộc trò chuyện khác được gắn với cùng task có thể đọc lại và tiếp tục. Mỗi bản gồm mục tiêu, việc đã xong, kiểm tra đã chạy/kết quả, việc còn lại, blocker và bước tiếp theo cụ thể.

### Thực hiện

- Theo dõi toàn bộ luồng đăng ký tool → dispatch → task/session → setTaskHandoff trước khi sửa.
- Đưa task_handoff vào slim sau khi bảo đảm đường update thực thi kiểm tra quyền.
- Giữ schema action=read/update và các giới hạn độ dài hiện có nếu không có lý do tương thích buộc phải đổi.
- Task luôn lấy từ binding của session; không nhận taskId/workspace tùy ý để chọn nơi ghi.
- Read được phép cho session có quyền đọc task, kể cả session không giữ writer trong Basic.
- Update phải kiểm tra task còn cho phép sửa và writer của Basic. Session khác không được ghi đè handoff.
- Chính sách đề xuất: Ask tạo đúng một operation chờ duyệt; Auto/Full cho phép cập nhật metadata task trong phạm vi hẹp này sau kiểm tra writer/lifecycle. Phân loại metadata rõ ràng, không mở rộng quyền shell, filesystem hoặc upstream.
- Approval thực thi request gốc một lần. Kiểm tra lại quyền liên quan khi thực thi; từ chối hoặc hết hạn không thay đổi handoff. Không tự gửi lại request pending.
- Không gắn nhãn readOnlyHint=true cho tool có action update.
- Tái sử dụng cơ chế lưu handoff; không cho phép ghi raw control files. Tránh khóa lồng nhau gây deadlock khi kết hợp dispatch và setTaskHandoff.
- Lịch sử thao tác phải phản ánh đúng cập nhật metadata; không tuyên bố file Undo khôi phục handoff nếu chưa có hỗ trợ đó.
- Bổ sung hướng dẫn agent đọc handoff khi tiếp nhận task và cập nhật nó sau một mốc công việc đáng kể hoặc trước khi bàn giao. Không cập nhật sau mọi tool call.

### Nghiệm thu

- tools/list qua HTTP MCP thật ở profile slim có task_handoff.
- Ghi handoff ở session A, tạo session B gắn cùng task, đọc được cùng dữ liệu.
- Hai task/workspace không đọc hoặc cập nhật nhầm handoff của nhau.
- Basic: session không giữ writer đọc được nhưng update bị từ chối, dữ liệu không đổi.
- Ask: pending → approve chạy một lần; deny/expired không ghi. Bao phủ đổi writer/policy khi đang chờ.
- Auto/Full: đường cập nhật hợp lệ chạy được; task không còn cho phép sửa vẫn bị chặn.
- Update trong workspace-only được phân loại đúng, không cần nới quyền tiến trình hay sửa trực tiếp control files.

### File cần xem

src/lib/tool-profile.ts; src/server-factory.ts; src/lib/workbench-tools.ts; src/lib/workbench.ts; src/lib/codex-agent-prompt.ts; src/lib/quickstart.ts.
Kiểm thử liên quan: scripts/test-tool-profile.mjs; scripts/test-chatgpt-web.mjs; scripts/test-workbench.mjs; scripts/test-experience.mjs.

## Phần 2 — Nạp được ghi chú mới khi bộ nhớ dài

### Kết quả cần có

Sau khi ghi nhiều ghi chú vượt ngân sách, cuộc trò chuyện mới vẫn thấy ghi chú gần nhất. Nội dung cũ vẫn còn trên đĩa để tra cứu.

### Thực hiện

- Giữ MEMORY.md hiện có và khả năng đọc dữ liệu cũ; không tự xóa hoặc ghi đè lịch sử.
- Thay chiến lược lấy đầu file bằng chọn các ghi chú gần nhất trong giới hạn dòng và byte hiện có.
- Ưu tiên giữ trọn từng ghi chú, kể cả ghi chú nhiều dòng; trong phần được chọn, giữ thứ tự thời gian dễ hiểu.
- Với một ghi chú riêng lẻ vượt ngân sách, trả phần nội dung hợp lệ và đánh dấu cắt bớt. Không cắt hỏng ký tự UTF-8, tiếng Việt hoặc emoji.
- Nếu không nhận diện được format cũ, có fallback đọc phần cuối theo dòng với đánh dấu rõ ràng.
- Ngân sách phải tính cả header và thông báo cắt bớt. Khi có lịch sử bị lược bỏ, cho biết còn dữ liệu trên đĩa và cách đọc tiếp bằng tool có sẵn.
- Giữ tương thích các biến AUTO_MEMORY_MAX_BYTES và AUTO_MEMORY_MAX_LINES; kiểm tra giá trị cấu hình không hợp lệ.
- Kiểm tra nơi ghi remember và nơi đọc khi khởi tạo session thật sự cùng workspace/worktree. Không lấy process-wide default để thay pinned execution context.
- Không thêm API model hoặc thuật toán tự suy diễn để tóm tắt ngữ nghĩa. GPT Web chủ động viết bản trạng thái ngắn vào handoff; bộ nhớ lưu quyết định hoặc kiến thức dùng lại.

### Nghiệm thu

- Fixture hơn 200 dòng: ghi chú mới nhất xuất hiện; dữ liệu gốc trên đĩa không mất.
- Fixture vượt 25.000 byte, nhiều dòng, tiếng Việt/emoji: output đúng ngân sách và không hỏng ký tự.
- Bao phủ file rỗng, chưa có file, file cũ và ghi chú đơn lẻ rất dài.
- Qua MCP: remember ở execution root A → session mới gắn A nạp được ghi chú; task dùng execution root B khác không nhận dữ liệu A. Các task cùng execution root vẫn có thể dùng chung bộ nhớ dự án theo thiết kế hiện có.
- Có thông báo lược bỏ lịch sử và cách tra cứu, không âm thầm bỏ nội dung.

### File cần xem

src/lib/auto-memory.ts; src/lib/instruction-context.ts; src/tools/context.ts; src/lib/mcp-session-manager.ts.
Mở rộng kiểm thử bộ nhớ bằng fixture tạm; có thể thêm scripts/test-auto-memory.mjs và đưa vào bộ test hiện có. test-project-memory.mjs hiện chủ yếu kiểm tra cấu trúc instructions nên chưa đủ chứng minh hành vi này.

## Phần 3 — Workbench trả trạng thái ngắn mặc định

### Kết quả cần có

workbench() đủ để biết đang làm ở đâu, quyền gì, có gì đang chờ và có bản bàn giao hay không, mà không mang toàn bộ lịch sử review vào ngữ cảnh.

### Thực hiện

- Thêm lựa chọn view=summary/history, mặc định summary.
- Summary giữ thông tin nhận diện task/workspace/execution path, policy, experience, session/write control và capabilities.
- Trả số thao tác pending/running/failed cùng danh sách ngắn ID/tool/status cần chú ý. Nếu danh sách bị giới hạn, phải có total/truncated và cách lấy tiếp.
- Chỉ trả thông tin bàn giao ngắn: có/không, thời điểm, excerpt có ngân sách; bản đầy đủ đọc bằng task_handoff.
- Mặc định không kèm diff/review dài, command arguments hay result của thao tác cũ. Giữ field operations nếu cần tương thích, nhưng mô tả rõ nội dung tóm tắt mới.
- History có limit mặc định 10, tối đa 30 và cursor để đọc tiếp. Cursor phải thuộc task hiện tại; task khác không được truy xuất nhầm lịch sử.
- Giữ hoạt động và kiểm tra quyền của workbench(operation_id) để lấy kết quả approval. Không cắt mất kết quả cần thiết của đường này.
- Kiểm tra các consumer trước khi thay output; tránh thay schema/envelope hoặc thêm lớp hạ tầng không cần thiết.
- Cập nhật mô tả tool và hướng dẫn agent để chỉ xin history khi cần.

### Nghiệm thu và phép đo

- Fixture có 30 operations và review dài: summary không chứa diff/body/result cũ.
- Đo số byte JSON và độ dài text thực sự gửi qua MCP trước/sau trên cùng fixture; mục tiêu giảm ít nhất 60% cho phản hồi trạng thái.
- Quyền, binding và các pending operation vẫn có thể xác định hoặc truy xuất đầy đủ.
- History phân trang không mất/lặp dữ liệu khi đọc một lịch sử không đổi; xác định hành vi khi thao tác mới được thêm.
- operation_id cùng task trả kết quả như trước; task khác bị từ chối.
- Qua MCP thật, kiểm tra summary/history/operation_id với Ask và workspace-only.
- Kích thước output là số đo payload; không gọi đó là số token hoặc tốc độ ChatGPT nếu chưa đo được.

### File cần xem

src/lib/workbench-tools.ts; src/lib/workbench.ts; src/lib/quickstart.ts; src/lib/codex-agent-prompt.ts; scripts/test-chatgpt-web.mjs; scripts/test-workbench.mjs.

## Phần 4 — Kiểm thử tổng hợp, tài liệu và bàn giao

### Kiểm tra cần chạy

Đọc lại package.json để chọn lệnh hiện hành. Sau mỗi phần, build nếu sửa TypeScript và chạy các regression liên quan. Trước bàn giao toàn bộ thay đổi core, chạy npm test.

Các script hiện có để chọn:

- npm run build
- node scripts/test-tool-profile.mjs
- node scripts/test-project-memory.mjs
- node scripts/test-chatgpt-web.mjs
- node scripts/test-workbench.mjs
- node scripts/test-experience.mjs
- Script bộ nhớ mới nếu có
- npm test

Không cần chạy test:integration cho upstream nếu không thay bridge/upstream. Không chạy lặp các bộ test đã pass trừ khi có thay đổi hoặc nghi ngờ mới.

Qua LocalCode: dùng start_process với working_directory rõ ràng; nếu running=true, dùng process_output với cursor vừa trả và wait_ms=10000. Giữ cursor mới, không chạy lại lệnh chỉ để lấy log.

Nếu thất bại, phân biệt regression do thay đổi với lỗi có sẵn. Báo rõ exit code, nguyên nhân và kiểm tra chưa hoàn tất. Fixture không dùng control directory hoặc credential của server live.

### Tài liệu và báo cáo

- Cập nhật AGENTS.md và docs/chatgpt-web-performance.md cùng tài liệu experience nếu hành vi bàn giao thay đổi.
- Ghi quy trình: bắt đầu đọc workbench summary → đọc handoff khi tiếp nhận → làm một mốc nhỏ → chạy kiểm thử → cập nhật handoff.
- Ghi rõ các giới hạn: không tự mở chat mới hoặc ép ChatGPT tiếp tục; không tự tăng context/quota; file Undo không bao phủ mọi tác động shell/remote.
- Báo các file thay đổi, hành vi trước/sau, lệnh kiểm thử và kết quả, số byte payload trước/sau, điểm còn chưa đo.
- Benchmark end-to-end trên ChatGPT Web chỉ được báo khi thực sự chạy cùng model, cùng snapshot, cùng tác vụ và có thời gian/số tool call/kết quả đo được. Kiểm thử server local không chứng minh chất lượng hay tốc độ của mô hình.
- Không tự commit, push, publish, restart server hoặc tunnel trong gói công việc này. Bàn giao diff đã kiểm tra; nêu bước refresh connector sau khi bản build được người dùng đưa vào sử dụng.

## Khi cuộc trò chuyện phải dừng giữa chừng

Lưu bản bàn giao gồm:

- Phần đang thực hiện và mục tiêu.
- Các file đã sửa.
- Kiểm thử đã chạy, exit code và lỗi còn lại.
- Thao tác đang pending hoặc process đang chạy, kèm ID/cursor nếu có.
- Bước kế tiếp đủ cụ thể để cuộc trò chuyện mới thực hiện ngay.

Nếu task_handoff chưa khả dụng hoặc connector chưa refresh, dùng cơ chế ghi nhớ sẵn có trong đúng task nếu được phép và đưa bản bàn giao vào câu trả lời. Không sửa control files để thay tool.

## Tiêu chí hoàn thành toàn bộ

1. Bàn giao đọc/ghi được trong slim, đúng task và đúng quyền.
2. Bộ nhớ vượt ngưỡng vẫn đưa được thông tin gần nhất vào ngữ cảnh.
3. Workbench mặc định ngắn; vẫn lấy được lịch sử và kết quả approval khi cần.
4. Regression liên quan và npm test đều pass. Nếu còn lỗi, báo phần chưa hoàn thành, phân biệt lỗi mới với lỗi nền bằng bằng chứng; không tuyên bố toàn bộ kiểm thử đã pass.
5. Tài liệu và bản bàn giao phản ánh hành vi thực tế, kèm số đo payload có thể kiểm chứng.
