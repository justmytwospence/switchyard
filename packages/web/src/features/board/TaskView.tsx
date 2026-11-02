import { useParams } from "react-router";
import { useBreakpoint } from "../../app/useBreakpoint";
import { BoardDesktop } from "./BoardDesktop";
import { TaskDetailPage } from "./BoardMobile";
import { MoveProvider } from "./MoveProvider";

/**
 * /tasks/:taskId: on desktop and compact widths the board with the task
 * drawer open (deep link); on mobile a full-screen task detail.
 */
export default function TaskView() {
  const { taskId = "" } = useParams();
  const bp = useBreakpoint();
  return (
    <MoveProvider>
      {bp === "mobile" ? <TaskDetailPage taskId={taskId} /> : <BoardDesktop taskId={taskId} />}
    </MoveProvider>
  );
}
