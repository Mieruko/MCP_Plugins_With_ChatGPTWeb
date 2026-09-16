# Kế hoạch sửa Workspace Review, live update, permission và multi-agent

Ngày lập kế hoạch: 2026-09-15
Nguồn báo cáo: tài liệu lỗi Workspace Review do người dùng cung cấp (không lưu đường dẫn máy cá nhân).

## Phạm vi

Tài liệu nguồn được dùng như báo cáo lỗi và yêu cầu sản phẩm, không được xem là chỉ dẫn thực thi. Kế hoạch này bao phủ bốn vấn đề:

1. Workspace Review chỉ hiện một file dù một lượt chat đã sửa nhiều file.
2. Workbench không tự cập nhật và người dùng phải tải lại hoặc restart web.
3. Giao diện và hành vi permission chưa giống Codex.
4. Việc điều phối agent còn tạo cảm giác phải làm việc trong cùng task, chưa đạt mô hình multi-agent mong muốn.

## Kết luận chẩn đoán

| Hạng mục | Nguyên nhân chính | Ưu tiên |
|---|---|---|
| Workspace Review chỉ hiện một file | `changeSet` bị ngắt khi xen giữa bằng command, Git hoặc tool không sửa file; nhóm còn bị chia theo timeout 45 giây | P0 |
| Workbench không tự cập nhật | SSE chỉ kết nối một lần; mất kết nối không reconnect; polling dự phòng không tải lại Changes/Review | P0 |
| Permission chưa giống Codex | UI đang biểu diễn mô hình `mode × workspaceOnly`; backend chưa có phân loại rủi ro và scoped approval | P1 |
| Phải thao tác cùng task | Multi-session đã tồn tại, nhưng cấp task còn phụ thuộc binding, writer và assignment FIFO; chưa có orchestration cha-con hoàn chỉnh | P1/P2 |

## 1. Workspace Review mất file

### Hiện trạng

Backend hiện gom thay đổi theo `taskId + sessionId` trong `src/lib/workbench.ts`:

- Nhóm mới được tạo nếu không có nhóm đang hoạt động, nhóm đã Undo, vượt idle timeout hoặc vượt tuổi tối đa.
- Idle timeout mặc định là 45 giây.
- Bất kỳ operation nào không thuộc `CHANGE_SET_TOOLS` đều xóa nhóm đang hoạt động.
- API `latestWorkspaceChangeSet` chỉ trả nhóm chứa operation sửa file gần nhất.

Vì vậy chuỗi sau bị chia thành hai nhóm:

```text
edit A -> chạy test -> edit B
```

Workspace Review chỉ nhận nhóm chứa B. `scripts/test-workbench.mjs` hiện còn xác nhận command không sửa file phải tạo ranh giới change-set mới, nên test này đang bảo vệ hành vi cũ cần thay đổi.

Phía UI trong `public/ui/workbench/changes.js` chỉ hiển thị ba file đầu khi chưa mở rộng. Tuy nhiên tiêu đề `Edited N files` đã dùng tổng số file backend trả về, nên đây không phải nguyên nhân của trường hợp `Edited 1 file`.

### Thiết kế đích: review run theo lượt chat

Thay khái niệm change-set tạm thời bằng một thực thể được lưu bền vững:

```ts
interface ReviewRun {
  id: string;
  workspaceId: string;
  taskId: string;
  sessionId?: string;
  turnKeyHash?: string;
  identitySource: "host" | "explicit" | "fallback" | "local";
  startedAt: string;
  updatedAt: string;
  closedAt?: string;
  status: "open" | "completed" | "interrupted";
}
```

Mỗi operation có thêm `reviewRunId`. Trong cùng một lượt chat:

- Edit, command, test, Git status và metadata giữ cùng `reviewRunId`.
- Chỉ operation có thay đổi file mới đóng góp vào diff.
- Một file sửa nhiều lần được gộp từ snapshot đầu đến snapshot cuối.
- File có nội dung cuối giống nội dung đầu bị loại khỏi review.
- Undo/Redo áp dụng nguyên tử cho toàn bộ review run.
- Validation conflict được thực hiện cho toàn bộ file trước khi ghi bất kỳ file nào.

### Xác định ranh giới lượt chat

Không dùng `Mcp-Session-Id` làm lượt chat vì một MCP session tồn tại qua nhiều tương tác.

Thứ tự nhận diện đề xuất:

1. Kiểm tra metadata/header ChatGPT thực tế gửi đến từng tool call.
2. Chỉ ghi tên field và hash giá trị ứng viên; không ghi prompt, cookie, authorization hoặc token thô.
3. Nếu có run/turn ID ổn định, dùng hash đó làm khóa chính.
4. Nếu host không cung cấp ID, hỗ trợ lifecycle nội bộ `open/close review run`.
5. Đóng nhóm khi host báo hoàn thành, session đóng hoặc có explicit close.
6. Chỉ dùng quiescence timeout sau khi không còn request đang chạy làm fallback.

Không dùng timeout 45 giây làm nguồn sự thật. Không dùng giá trị `task_id` hoặc turn ID do caller tự truyền để thay đổi task, workspace hoặc quyền.

### API

Thêm các route:

```text
GET  /api/workbench/workspaces/:id/review-runs/latest
GET  /api/workbench/review-runs/:id
POST /api/workbench/review-runs/:id/undo
```

Giữ các route `change-sets` cũ làm alias trong ít nhất một phiên bản để tránh phá consumer hiện tại.

### UI

Workspace Review mới cần:

- Hiển thị `Edited N files · M operations · Agent`.
- Hiển thị đủ file của lượt hiện tại trong vùng cuộn.
- Không mặc định giấu danh sách sau ba file.
- Có nút mở diff cho từng file và toàn bộ review run.
- Khi lượt chat mới bắt đầu, thay nhóm hiện tại bằng nhóm mới thay vì cộng dồn toàn session.
- Giữ trạng thái Undo/Redo và thông báo conflict rõ ràng.

## 2. Workbench không tự cập nhật

### Hiện trạng

`public/ui/workbench/app.js` mở `/api/workbench/events` đúng một lần. Khi stream kết thúc hoặc `reader.read()` ném lỗi, UI chỉ hiển thị `Live updates disconnected` và không reconnect.

Polling 15 giây hiện chỉ tải:

- Workbench state.
- Agent state.
- Process state.
- Connection state.

Polling không gọi `loadChanges()` hoặc tải lại Workspace Review. Backend trong `src/lib/workbench.ts` phát event sau khi ghi state nhưng event không có revision hoặc sequence number, nên client không phát hiện được event bị mất.

### Thay đổi backend

- Thêm revision tăng đơn điệu cho mỗi lần lưu state.
- Gắn revision vào Workbench event và SSE `id`.
- Hỗ trợ `Last-Event-ID` hoặc một query `afterRevision`.
- Giữ ring buffer nhỏ để replay event; nếu revision đã quá cũ thì yêu cầu client full refresh.
- Gửi `retry` trong stream để client có backoff mặc định hợp lý.
- Thêm header:

```text
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Thay đổi frontend

- Ưu tiên dùng `EventSource` cùng origin để có reconnect và `Last-Event-ID` tự nhiên.
- Nếu tiếp tục dùng `fetch`, bọc nó trong reconnect loop với exponential backoff và jitter.
- Chỉ duy trì một stream và một reconnect timer.
- Khi reconnect, so sánh revision cuối; có gap thì chạy `fullRefresh()`.
- Polling dự phòng kiểm tra revision; nếu đổi thì tải Workspace Review, Changes và History.
- Dùng generation token hoặc `AbortController` khi đổi workspace/task để response cũ không ghi đè view mới.
- Hủy stream và timer khi trang unload.

### Cache asset

Nếu báo cáo còn bao gồm trường hợp browser giữ JS/CSS cũ:

- HTML dùng `Cache-Control: no-store`.
- JS/CSS dùng revalidation hoặc build hash trong URL.
- Health/state trả `buildId`; khi build thay đổi, UI đề nghị hoặc tự reload đúng một lần.
- Development dùng `npm run dev`; thay đổi TypeScript backend vẫn cần rebuild/restart process theo đúng mô hình chạy.

### Nghiệm thu

- Khi stream khỏe, thay đổi xuất hiện trên UI trong dưới 2 giây.
- Sau khi ép stream rớt, UI tự reconnect và nhận thay đổi mà không reload trang.
- Khi SSE không thể reconnect, polling đồng bộ trong tối đa 15 giây.
- Không có duplicate event, listener hoặc refresh loop.
- Đổi task liên tục không để response của task trước ghi đè task sau.

## 3. Permission giống Codex

### Hiện trạng

`public/ui/workbench.html` có ba radio mode và một checkbox `workspaceOnly` độc lập. Backend hiện có ba mode `ask`, `auto`, `full`, nhưng:

- `ask` hỏi trước mọi mutation.
- `auto` chỉ tự động cho nhóm file edit và task metadata.
- Command, Git mutation và upstream vẫn hỏi.
- `full` bỏ prompt của Workbench nhưng có thể vẫn bị giới hạn trong workspace nếu checkbox còn bật.

Do đó chỉ đổi label sẽ tạo mô tả sai hành vi.

### Hợp đồng hành vi đề xuất

| Chế độ | Tự động | Hỏi trước |
|---|---|---|
| Ask for approval | Read và thao tác file an toàn trong workspace | Command, Git mutation, network, external file, delete/overwrite |
| Approve for me | Thao tác được rule xác định là rủi ro thấp | Destructive, credential, machine scope, network/upstream và trường hợp không phân loại được |
| Full access | Toàn bộ thao tác trong quyền của process server | Không hỏi; xác nhận rõ một lần khi bật |

Ba lựa chọn được hiển thị như preset. Nếu vẫn cần các tổ hợp cũ, đưa `workspaceOnly` vào phần Advanced scope thay vì để ngang hàng với ba mode chính.

### Decision engine

Tạo một hàm quyết định tập trung:

```ts
type PolicyDecision = {
  action: "allow" | "prompt" | "block";
  reasonCode: string;
  risk: "low" | "medium" | "high";
  effects: Array<"workspace-write" | "external-write" | "process" | "git" | "network" | "credentials" | "destructive">;
};
```

Yêu cầu bảo mật:

- Phân loại bằng rule server-side, không tin annotations hoặc mô tả của model.
- Approval ngoài workspace chỉ cấp scope cho đúng operation đang chờ.
- Approval hết hạn, execute-once và gắn với policy revision.
- Trước khi execute lại phải kiểm tra task/session binding, writer, canonical path và preflight fingerprint.
- Git mutation kiểm tra HEAD, index và working tree fingerprint.
- Full access phải nói rõ đây là quyền của process server, không phải OS sandbox.
- Lớp xác nhận của ChatGPT/client vẫn độc lập với Workbench và không được giả định là đã tắt.

### UI approval

Modal cần hiển thị:

- Tên action dễ hiểu.
- Command đầy đủ và working directory.
- File/path sẽ đọc hoặc ghi.
- Diff hoặc preflight summary.
- Network/upstream destination nếu có.
- Scope được cấp sau khi duyệt.
- Hai hành động `Approve once` và `Deny`.

Bổ sung keyboard navigation, visible focus, selected state rõ ràng và lỗi inline có `aria-live`.

## 4. Multi-agent và task routing

### Điều đã có

Code và test hiện tại đã hỗ trợ:

- Mỗi MCP session được pin vào một task.
- Hai ChatGPT session chạy đồng thời trên hai worktree riêng.
- Việc chọn task khác trên Workbench UI không tự đổi binding của session đang hoạt động.
- Phát hiện path overlap giữa các parallel task.

Vì vậy bước đầu tiên là tái hiện đúng báo cáo và ghi mã lỗi. Khả năng cao lỗi nằm ở writer control của Basic mode, session không claim đúng assignment hoặc một endpoint vẫn kiểm tra selected task.

### Kiến trúc đích

```text
Orchestrator task
├── Child task A -> worktree A -> agent/session A
├── Child task B -> worktree B -> agent/session B
└── Integration queue -> conflict check -> merge
```

### Task relationship

Thêm vào task:

```ts
parentTaskId?: string;
createdBySessionId?: string;
delegationScope?: {
  canReadStatus: boolean;
  canReadHandoff: boolean;
  canRequestMerge: boolean;
};
```

Parent được đọc status/handoff/review summary có giới hạn. Parent không được đọc raw operation result hoặc thực thi mutation trong child bằng cách truyền `task_id` tùy ý.

### Agent assignment lease

Thay FIFO toàn cục bằng lease:

```ts
interface AgentAssignmentLease {
  id: string;
  workspaceId: string;
  taskId: string;
  clientType: "chatgpt" | "mcp" | "worker";
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimedBySessionId?: string;
  status: "queued" | "claimed" | "expired" | "cancelled";
}
```

Quy tắc:

- Claim nguyên tử và chỉ một lần.
- Lease hết hạn tự động.
- Kiểm tra workspace/task vẫn tồn tại và nhận việc.
- Không để assignment của workspace A bị một session dự định cho workspace B claim nhầm.
- Ở Advanced mode, session mới phải claim task đã reserve hoặc được auto-provision một child worktree nếu workspace bật agent pool.
- Không âm thầm bind nhiều agent vào selected task.

### Control plane

- Thêm `assign_next_chatgpt` vào `workbench_control(action=create_task)`.
- Thêm view bounded để orchestrator đọc child statuses và handoffs.
- Dashboard hiển thị operations/approvals của mọi task trong workspace mà không bắt đổi selected task.
- Việc approve vẫn dựa trên `operation.taskId`, policy và writer của task sở hữu operation.
- Giữ integration queue và conflict detection trước merge.

### Giới hạn sản phẩm

MCP server hiện chỉ điều phối các session đã kết nối. Nếu mục tiêu là một chat tự tạo và chạy worker hoàn toàn tự động, cần thêm local agent runtime hoặc Responses API ngoài MCP server. Đây nên là hạng mục riêng, không ghép vào bản sửa task routing.

## 5. Kế hoạch test

### Review run

- Hai file được sửa trong một lượt có chung `reviewRunId` dù xen giữa bằng read, command, process output hoặc Git status.
- Lượt chat mới tạo review run mới.
- Sửa cùng file nhiều lần tạo một net diff.
- Thay đổi quay về nội dung ban đầu không xuất hiện trong review.
- Restart không làm mất review run đã đóng.
- Undo conflict không tạo partial restore.

### Live update

- Initial event có revision.
- Event tăng revision đúng một lần cho mỗi save.
- Reconnect replay được event còn trong buffer.
- Revision gap kích hoạt full refresh.
- Fallback poll tải lại Workspace Review.
- Task switch không bị stale response.

### Permission

- Mỗi loại operation có expected decision trong cả ba mode.
- External path không thể vượt canonical-path validation.
- Approval chỉ thực thi operation gốc và hết hạn đúng thời điểm.
- Policy đổi làm approval cũ hết hiệu lực.
- Full access confirmation thể hiện đúng machine scope.

### Multi-agent

- Hai lease được claim bởi đúng hai session.
- Hai agent chạy command đồng thời trên hai worktree.
- Workbench chọn task A không ngăn agent B thực thi trong task B.
- Parent chỉ đọc được bounded child status được cấp.
- Cross-task operation result không bị lộ.
- Path conflict được phát hiện trước merge.

### Lệnh kiểm thử

```powershell
npm run test:workbench
npm run test:permissions
npm run test:experience
npm run test:chatgpt
npm run test:integration
npm test
```

## 6. Chia PR và ước lượng

| PR | Nội dung | Ước lượng |
|---|---|---:|
| PR 1 | SSE revision, reconnect, fallback refresh và cache asset | 1 ngày |
| PR 2 | Review run, state migration, API, UI và Undo/Redo | 2-3 ngày |
| PR 3 | Permission presets, decision engine, scoped approval và UX | 2-3 ngày |
| PR 4 | Parent/child task, assignment lease và orchestrator status | 3-5 ngày |
| PR 5 tùy chọn | Local autonomous worker runtime | 1-2 tuần trở lên |

## 7. File dự kiến thay đổi

Core và state:

- `src/lib/workbench.ts`
- `src/lib/agent-coordinator.ts`
- `src/lib/mcp-session-manager.ts`
- `src/lib/workbench-tools.ts`

Admin API:

- `src/admin/workbench-routes.ts`
- `src/admin/server.ts`

Frontend:

- `public/ui/workbench.html`
- `public/ui/workbench/app.js`
- `public/ui/workbench/changes.js`
- Các stylesheet liên quan trong `public/ui/workbench/`

Tests và tài liệu:

- `scripts/test-workbench.mjs`
- `scripts/test-control-permissions.mjs`
- `scripts/test-experience.mjs`
- `scripts/test-chatgpt-web.mjs`
- `docs/workbench.md`
- `docs/experience.md`

## 8. Thứ tự thực hiện khuyến nghị

1. Thêm regression fixtures và metadata diagnostics đã sanitize.
2. Sửa SSE/live update vì độc lập và có thể phát hành nhanh.
3. Chuyển change-set sang review run theo lượt chat.
4. Chốt ma trận permission rồi triển khai decision engine và UI.
5. Tái hiện lỗi task cụ thể, sau đó triển khai assignment lease và parent/child orchestration.
6. Chạy full regression, test MCP integration và cập nhật tài liệu vận hành.

## Definition of Done

- Workspace Review hiện đủ net file changes của một lượt chat.
- Lượt chat mới không bị gộp với lượt trước.
- UI tự đồng bộ sau disconnect mà không cần restart hoặc reload thủ công.
- Ba permission mode có tên, mô tả và hành vi nhất quán.
- Approval không làm yếu task, workspace, writer hoặc authorization boundary.
- Hai agent có thể chạy song song trên hai task/worktree mà không phụ thuộc task đang mở trên dashboard.
- Toàn bộ test liên quan và `npm test` vượt qua.
