"""Render the pinned backend's real snapshot format without desktop capture."""
import json
import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("workbench_windows_adapter", Path(__file__).resolve().parents[1] / "computer-windows-bridge.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
adapter.install_adapter()
import windows_mcp.tree.service as tree_service
import windows_mcp.desktop.service as desktop_service
assert desktop_service.Desktop.get_controls_handles is adapter.scoped_controls_handles
fake_gui = SimpleNamespace(GetForegroundWindow=lambda: 17, IsWindow=lambda handle: handle in (17, 42),
                           IsWindowVisible=lambda handle: handle in (17, 42), GetAncestor=lambda handle, mode: 42)
assert adapter.focused_window_handles(fake_gui, SimpleNamespace(GA_ROOT=2)) == {42}
fake_gui.GetForegroundWindow = lambda: 0
assert adapter.focused_window_handles(fake_gui, SimpleNamespace(GA_ROOT=2)) == set()
rectangle = SimpleNamespace(left=-200, top=100, width=lambda: 100, height=lambda: 80)
control = SimpleNamespace(BoundingRectangle=rectangle)
assert {tree_service.random_point_within_bounding_box(control, 0.8) for _ in range(20)} == {(-150, 140)}
rectangle.left += 10
assert tree_service.random_point_within_bounding_box(control, 0.8) == (-140, 140)
rectangle.height = lambda: 0
try:
    tree_service.random_point_within_bounding_box(control, 0.8)
    raise AssertionError("Empty rectangle accepted")
except ValueError:
    pass
from windows_mcp.desktop.views import DesktopState, Window, Status
from windows_mcp.tree.views import TreeState, SemanticNode, Center, BoundingBox
from windows_mcp.tools._snapshot_helpers import build_snapshot_response

root = SemanticNode(control_type="Desktop", element_type="desktop")
app = SemanticNode(control_type="Window", element_type="window", name="CU fixture")
app.children = [
    SemanticNode(control_type="Button", element_type="interactive", name="Click me", center=Center(100, 200)),
    SemanticNode(control_type="Edit", element_type="interactive", name="Description", center=Center(100, 250), metadata={"has_focused": True}),
]
bar = SemanticNode(control_type="Window", element_type="window", name="Taskbar")
bar.children = [SemanticNode(control_type="Button", element_type="interactive", name="10:00", center=Center(900, 900))]
root.children = [app, bar]
tree = TreeState(semantic_tree_root=root)
state = DesktopState(
    active_desktop={"name": "Desktop 1"}, all_desktops=[{"name": "Desktop 1"}],
    active_window=Window("CU fixture", False, 0, Status.NORMAL, BoundingBox(0, 0, 800, 600, 800, 600), 12345, 1),
    windows=[Window("Other 10:00", False, 1, Status.NORMAL, BoundingBox(0, 0, 300, 200, 300, 200), 54321, 2)],
    tree_state=tree, cursor_position=(10, 20),
)
result = build_snapshot_response({
    "desktop_state": state, "interactive_elements": tree.interactive_elements_to_string(),
    "scrollable_elements": tree.scrollable_elements_to_string(), "semantic_tree": tree.semantic_tree_to_string(),
    "windows": state.windows_to_string(), "active_window": state.active_window_to_string(),
    "active_desktop": state.active_desktop_to_string(), "all_desktops": state.desktops_to_string(),
    "screenshot_bytes": None,
}, include_ui_details=True)
if "--serve" in sys.argv:
    # Use the installed FastMCP serializer and real stdio protocol. Returning a
    # list of strings is materially different from printing its first element.
    from fastmcp import FastMCP
    from fastmcp.utilities.types import Image
    import base64
    mcp = FastMCP("windows-snapshot-protocol-fixture")

    @mcp.tool(name="Snapshot")
    def snapshot(use_vision: bool = False, use_ui_tree: bool = True):
        blocks = list(result)
        if use_vision:
            blocks.append(Image(data=base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), format="png"))
        return blocks

    @mcp.tool(name="Shortcut")
    def shortcut(shortcut: str):
        return "Fixture acknowledged: " + shortcut

    mcp.run(transport="stdio", show_banner=False)
else:
    print(json.dumps(result[0], ensure_ascii=True))
