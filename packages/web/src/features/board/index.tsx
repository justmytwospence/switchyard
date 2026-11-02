import { useBreakpoint } from "../../app/useBreakpoint";
import { BoardDesktop } from "./BoardDesktop";
import { BoardMobile } from "./BoardMobile";
import { MoveProvider } from "./MoveProvider";

/** /board: columns on desktop and compact widths, status tabs on mobile (spec 13, 14). */
export default function BoardView() {
  const bp = useBreakpoint();
  return <MoveProvider>{bp === "mobile" ? <BoardMobile /> : <BoardDesktop />}</MoveProvider>;
}
