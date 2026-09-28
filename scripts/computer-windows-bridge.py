"""Workbench compatibility adapter for the pinned Windows-MCP runtime.

Upstream randomizes scroll-container points on every capture. Stable centers
let Workbench compare geometry without disabling its stale-observation guard.
Only this child process is patched; installed packages remain untouched.
"""
from importlib.metadata import version


def stable_scroll_point(node, scale_factor=1.0):
    box = node.BoundingRectangle
    width, height = box.width(), box.height()
    if width <= 0 or height <= 0:
        raise ValueError("Scrollable control has no visible rectangle")
    return (box.left + width // 2, box.top + height // 2)


def focused_window_handles(gui=None, constants=None):
    """Never enumerate unrelated applications or Explorer/Taskbar UIA trees.

    A dialog becomes the new foreground root, so the controller's existing
    title/handle guard still decides whether it is authorized for automation.
    """
    if gui is None:
        import win32gui as gui
    if constants is None:
        import win32con as constants
    handle = gui.GetForegroundWindow()
    if not handle or not gui.IsWindow(handle) or not gui.IsWindowVisible(handle):
        return set()
    root = gui.GetAncestor(handle, constants.GA_ROOT) or handle
    return {root} if gui.IsWindow(root) and gui.IsWindowVisible(root) else set()


def scoped_controls_handles(self, optimized=False):
    return focused_window_handles()


def install_adapter():
    if version("windows-mcp") != "0.8.6":
        raise RuntimeError("Workbench Windows adapter requires windows-mcp 0.8.6")
    import windows_mcp.tree.service as tree_service
    import windows_mcp.desktop.service as desktop_service
    tree_service.random_point_within_bounding_box = stable_scroll_point
    desktop_service.Desktop.get_controls_handles = scoped_controls_handles


if __name__ == "__main__":
    install_adapter()
    from windows_mcp.__main__ import main
    main()
