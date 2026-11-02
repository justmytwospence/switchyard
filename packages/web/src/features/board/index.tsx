import { useMatch } from "react-router";
import { useBreakpoint } from "../../app/useBreakpoint";
import { BoardDesktop } from "./BoardDesktop";
import { BoardMobile, TaskDetailPage } from "./BoardMobile";
import { MoveProvider } from "./MoveProvider";

/**
 * /board and /tasks/:taskId (spec 13, 14). Both routes render this one view so the board stays
 * mounted while the task drawer opens and closes. Desktop and compact: columns with the task
 * drawer for /tasks/:taskId. Mobile: status tabs, and a full-screen task detail for
 * /tasks/:taskId (the board restores its scroll position on Back).
 */
export default function BoardView() {
  const bp = useBreakpoint();
  const match = useMatch("/tasks/:taskId");
  const taskId = match?.params.taskId;
  return (
    <MoveProvider>
      {bp !== "mobile" ? (
        <BoardDesktop taskId={taskId} />
      ) : taskId ? (
        <TaskDetailPage key={taskId} taskId={taskId} />
      ) : (
        <BoardMobile />
      )}
    </MoveProvider>
  );
}
