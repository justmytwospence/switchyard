import { useBreakpoint } from "../../app/useBreakpoint";
import { useWorkBoard } from "./useWorkBoard";
import { WorkBoardDesktop } from "./WorkBoardDesktop";
import { WorkBoardMobile } from "./WorkBoardMobile";

/** /board: branches by stage, or by a tracker's GitHub Projects columns (see docs/model.md). */
export default function WorkBoardView() {
  const bp = useBreakpoint();
  const board = useWorkBoard();
  return bp === "mobile" ? <WorkBoardMobile board={board} /> : <WorkBoardDesktop board={board} />;
}
