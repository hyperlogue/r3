// One feedback item, from its anchor header to its reply thread — the unit the
// panel lists. Split out of FeedbackPanel.tsx because it is a whole component's
// worth of behaviour on its own: two mutations, an edit mode with a turn
// boundary behind it, a keyboard command channel, quote-to-reply, and a claim
// badge — none of which the panel's own concerns (the composers, presence,
// hand-off, the collapsed rail) need to see.
//
// The memo discipline in FeedbackCard's own comment is load-bearing and survives
// the move intact: typing is this panel's hot path, and a card that re-renders on
// every keystroke is what the memo exists to prevent.

import type { AutoAnimationPlugin } from "@formkit/auto-animate";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { getDraft, setReplyText, useReplyDraft } from "../drafts.ts";
import { apiErrorText, shortSession } from "../format.ts";
import type { MessageRef } from "../markdown.ts";
import type { Author, FeedbackWithReplies, Reply, ReviewDetail } from "../types.ts";
import { SUMMARY_FILE } from "../types.ts";
import {
  Button,
  Collapse,
  cn,
  FoldTriangle,
  prefersReduced,
  scrollParent,
  TrashIcon,
  useEscape,
} from "../ui.tsx";
import { useOptimisticPatch } from "../useOptimistic.ts";
import { MessageProse, QuoteBubble, quoteBlock, useQuoteBubble } from "./Message.tsx";
import { MessageEditor, SUBMIT_KEYS, usePlaceholder } from "./MessageEditor.tsx";

// The reply thread: a new reply just fades in — no scale (auto-animate's default
// scale(.98)→1 was unwanted). Removals fade out; the visible pair reflows via FLIP.
const replyAnimation: AutoAnimationPlugin = (el, action, a, b) => {
  const reduce = prefersReduced();
  if (action === "add") {
    return new KeyframeEffect(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: reduce ? 0 : 250,
      easing: "ease-out",
    });
  }
  if (action === "remove") {
    return new KeyframeEffect(el, [{ opacity: 1 }, { opacity: 0 }], {
      duration: reduce ? 0 : 200,
      easing: "ease-in",
    });
  }
  const dx = (a?.left ?? 0) - (b?.left ?? 0);
  const dy = (a?.top ?? 0) - (b?.top ?? 0);
  return new KeyframeEffect(
    el,
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    { duration: reduce ? 0 : 200, easing: "ease-out" },
  );
};

// Human-readable target for summary feedback (the `file` sentinel + patch_seq):
// the review's own summary, or a specific diff round's.
export function summaryTargetLabel(patchSeq: number | null | undefined): string {
  return patchSeq != null ? `diff ${patchSeq} summary` : "review summary";
}

// A click that concluded a drag-selection shouldn't also fire the element's
// action (jump / expand) — otherwise the anchor line and the quoted code can't
// be selected to copy. A plain click leaves the selection collapsed (a caret),
// so the action still fires; a drag leaves a non-collapsed selection, which we
// read as "the user is copying text, don't act."
function clickEndedInSelection(): boolean {
  const sel = window.getSelection();
  return sel != null && !sel.isCollapsed && sel.toString().length > 0;
}

function locLabel(fb: FeedbackWithReplies): string {
  if (fb.file === SUMMARY_FILE) return summaryTargetLabel(fb.patch_seq);
  if (!fb.file) return "general";
  // Name the round when the anchor lives past the first one — in a multi-round
  // review "db.ts:L11" alone is ambiguous.
  const round = fb.patch_seq != null && fb.patch_seq > 1 ? `d${fb.patch_seq} · ` : "";
  if (fb.line_start == null) return `${round}${fb.file}`;
  const range =
    fb.line_end && fb.line_end !== fb.line_start
      ? `L${fb.line_start}-${fb.line_end}`
      : `L${fb.line_start}`;
  return `${round}${fb.file.split("/").pop()}:${range}`;
}

// A feedback "needs you" when the agent had the last word and it isn't resolved —
// the same turn boundary that gates Edit (canEdit below). Drives the attention-
// first ordering of the active list and the per-card unread dot: once you reply
// (you get the last word) or resolve it, it drops out of the attention zone.
export function needsAttention(fb: FeedbackWithReplies): boolean {
  if (fb.status === "resolved") return false;
  return (fb.replies.at(-1)?.author ?? fb.author) === "agent";
}

// The soft primary bubble marking agent-voiced content. An agent reply block and
// an agent-authored feedback body wear the exact same fill so "the agent's voice"
// reads as one surface — keep the two in lockstep through this constant.
const AGENT_BUBBLE = "rounded-md bg-primary-100/60 px-2.5 py-1.5 dark:bg-primary-500/15";

// One reply in a feedback thread. Only the agent's voice gets a soft tinted fill
// (faint primary blue) — a bubble that sets the responder apart. A human reply is
// the human's own voice, same as the feedback body above it, so it renders as
// plain prose flush with the body rather than a second styled block; that also
// keeps it from reading as quoted text (the left-border idiom belongs to the
// anchor quote). The author rides in the title for hover/accessibility.
function ReplyBlock({
  rp,
  editing,
  editValue,
  onEditChange,
  onEditSave,
  onEditCancel,
  canSave,
  onLocatePin,
  onJumpRef,
}: {
  rp: Reply;
  // The card puts its *last human reply* into edit mode (see FeedbackCard); every
  // other reply renders read-only. The editor is controlled from the card so its
  // Save/Cancel can live in the card's bottom action row (shared with body edits).
  editing: boolean;
  editValue: string;
  onEditChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  canSave: boolean;
  onLocatePin: (patchSeq: number, file: string | null, line: number | null) => void;
  // Jump the pane to an `@path:Lx-y` ref clicked inside this reply's rendered
  // Markdown (already bound with the reply's version context by the card).
  onJumpRef?: (ref: MessageRef) => void;
}) {
  const isAgent = rp.author === "agent";
  return (
    <div
      title={rp.author}
      data-reply-author={rp.author}
      className={cn("text-xs", isAgent && AGENT_BUBBLE)}
    >
      {editing ? (
        <MessageEditor
          value={editValue}
          onChange={onEditChange}
          onSubmit={() => {
            if (canSave) onEditSave();
          }}
          onCancel={onEditCancel}
          autoFocus
          className="-mx-3 w-[calc(100%_+_1.5rem)]"
        />
      ) : (
        // First-class content — same size as the feedback body and the file view,
        // rendered as Markdown. Relaxed leading so long agent replies don't read as
        // a wall of text.
        <MessageProse
          source={rp.body}
          className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-200"
          onJumpRef={onJumpRef}
        />
      )}
      {rp.patch_seq != null && !editing && (
        <button
          type="button"
          onClick={() => onLocatePin(rp.patch_seq!, rp.file, rp.line_start)}
          className="mt-1 block truncate font-mono text-[0.6875rem] text-success-700 hover:text-success-600 dark:text-success-400 dark:hover:text-success-300"
          title={`Jump to diff ${rp.patch_seq}${rp.file ? ` · ${rp.file}` : ""}`}
        >
          ↳ addressed in diff {rp.patch_seq}
          {rp.file
            ? ` · ${rp.file.split("/").pop()}${rp.line_start ? `:L${rp.line_start}` : ""}`
            : ""}
        </button>
      )}
    </div>
  );
}

// A keystroke aimed at one card (`r` / `e`). The panel owns the binding (it knows
// which card is active); the card owns the buttons and just clicks its own. Both
// guards FileCard's FoldSignal carries are needed here for the same reasons:
//
//   `id` — the addressed feedback, so the panel hands it to that card and null to
//   every other. Without it, pressing `r` and then `j` would deliver the same
//   command to the newly-focused card (its nonce goes undefined → n) and open a
//   composer the user never asked for. This is FoldSignal's `path`.
//
//   monotonic `nonce`, matched against a ref SEEDED AT MOUNT — so pressing the
//   same key twice fires twice, while a card remounting under a command it
//   already ran (a tab switch, or the remount a status change causes) doesn't
//   replay it. Replaying `e` would silently reopen the item it just resolved.
export type CardCommand = { id: string; action: "reply" | "resolve"; nonce: number };

// memo'd, because everything re-renders the panel: an SSE echo, a resize drag, a
// tab switch, the parent's own state. Without it each of those re-ran every card's
// mutation hooks and re-rendered its whole thread.
//
// The default shallow compare holds because no prop is built per render: `fb` is a
// row TanStack structurally shares (a new object only when this feedback actually
// changed), `reviewId`/`isActive`/`error` are primitives, `command` is null for
// every card but the addressed one, and every callback is one the panel keeps
// stable — which is why the five per-card ones take this card's row/id as an
// ARGUMENT rather than closing over it.
export const FeedbackCard = memo(function FeedbackCard({
  fb,
  reviewId,
  onLocate,
  onFocus,
  onLocatePin,
  onResolved,
  onReplied,
  onJumpRef,
  isActive,
  command,
  error,
  reportError,
}: {
  fb: FeedbackWithReplies;
  reviewId: string;
  onLocate: (fb: FeedbackWithReplies) => void;
  // Re-select this card without jumping the content pane (the error-recovery
  // "bring focus back" — the card matters there, not its anchor).
  onFocus: (fb: FeedbackWithReplies) => void;
  onLocatePin: (patchSeq: number, file: string | null, line: number | null) => void;
  onResolved: (id: string) => void;
  // Plain reply (no resolve) landed — hand focus to the next open item.
  onReplied: (id: string) => void;
  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message.
  onJumpRef: (ref: MessageRef, patchSeq: number | null) => void;
  isActive: boolean;
  command: CardCommand | null;
  // This card's last mutation error, and the reporter to set/clear it. Both live
  // on the panel (keyed by feedback id) rather than in the card's own mutation
  // state, so the message survives the unmount/remount that a status- or
  // membership-changing action (Resolve/Reopen/Delete) triggers — see the panel's
  // cardErrors store and the "Optimistic mutation plumbing" note below.
  error: string | null;
  reportError: (id: string, msg: string | null) => void;
}) {
  const qc = useQueryClient();
  const reviewKey = ["review", reviewId] as const;
  // The panel's reporter is one function shared by every card (that's what keeps
  // its identity stable), so bind this card's id to it once here.
  const report = useCallback((msg: string | null) => reportError(fb.id, msg), [reportError, fb.id]);
  // --- Optimistic mutation plumbing --------------------------------------
  // The card mutations below (resolve/reopen, reply, edit, delete) patch the
  // cached ReviewDetail in onMutate so the card reflects the change the instant
  // it's clicked, and roll the snapshot back in onError. A failed one also
  // reports the server's message via reportError — the error lives on the PANEL
  // (keyed by feedback id), not in the mutation's own isError, because a
  // status/membership change (resolve/reopen/delete) filters this card out of the
  // visible tab and unmounts it; the rollback then remounts a fresh card whose
  // local mutation state is pristine, so a card-local banner would vanish. There
  // is deliberately no onSettled
  // refetch: every write broadcasts an SSE event that this tab receives too, and
  // useServerEvents refetches the detail off it — so the live feed is the
  // success-path reconcile for the initiator and every other client alike, instead
  // of the mutation self-invalidating and racing its own echo (which fired the
  // review detail three times over). onMutate cancels any refetch in flight at
  // click time so it can't land over the optimistic patch — that closes only the
  // click-time window: an echo arriving mid-mutation (another client's write, or
  // leg 1 of reply+resolve) can still briefly refetch pre-commit state, which the
  // next echo heals. We deliberately do NOT synthesize the server-computed
  // delivery fields (sent_at, status_unsent, and the hasUnsentContent gating that
  // drives Copy/Submit) — a brief settle where the pill/anchor corrects itself
  // once the echo refetches is acceptable.
  const { beginPatch: snapshotPatch, restore } = useOptimisticPatch(reviewId);
  const beginPatch = async () => {
    // Clear any prior error banner as a new action starts (retry or a different
    // action on the same card) — the panel-level store persists it otherwise.
    report(null);
    return snapshotPatch();
  };
  // Replace this card's feedback row in the cached detail in place (a no-op if the
  // detail or the row is already gone).
  const patchThisFeedback = (fn: (f: FeedbackWithReplies) => FeedbackWithReplies) =>
    qc.setQueryData<ReviewDetail>(reviewKey, (d) =>
      d ? { ...d, feedback: d.feedback.map((f) => (f.id === fb.id ? fn(f) : f)) } : d,
    );
  // A stand-in reply row shown in the thread while the POST is in flight. Its id
  // is a throwaway the echo refetch discards, and the server-assigned fields
  // aren't known yet: sent_at/ref_version stay null (so its `@path` refs simply
  // don't resolve until the echo lands — fine transiently).
  const optimisticReply = (body: string): Reply => ({
    // Not crypto.randomUUID(): that's secure-context-only, and the SPA is served
    // over plain http on a non-loopback bind (R3_BIND) — Math.random is plenty
    // for a throwaway local id.
    id: `reply_tmp_${Math.random().toString(36).slice(2, 10)}`,
    feedback_id: fb.id,
    author: "human",
    body,
    patch_seq: null,
    file: null,
    line_start: null,
    line_end: null,
    quote: null,
    created_at: new Date().toISOString(),
    sent_at: null,
    ref_version: null,
  });
  // The in-progress reply lives in the browser draft store (drafts.ts), keyed by
  // review + this feedback's id — so it survives a review-switch/reload and lights
  // the hand-off pill, same as the new-feedback composers. setReply("") drops it.
  const reply = useReplyDraft(reviewId, fb.id);
  const setReply = useCallback((t: string) => setReplyText(reviewId, fb.id, t), [reviewId, fb.id]);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(fb.body);
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The reply composer is hidden by default; the action row (Resolve · ⋯ · Reply)
  // stays put, and clicking "Reply" reveals the textarea. Kept local so it's
  // independent of `isActive` (which only highlights the card + its region). Seeded
  // open when a persisted reply draft is waiting, so it restores on reload/switch.
  const [replyOpen, setReplyOpen] = useState(
    () => (getDraft(reviewId)?.replies[fb.id]?.trim() ?? "") !== "",
  );
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Animate a new reply sliding into the thread (and the reflow when the oldest of
  // the shown pair rolls up into the "earlier" fold) — the same treatment the
  // feedback list gets. Scoped to the visible last-two container; the folded
  // earlier ones already animate via their Collapse.
  const [replyAnim] = useAutoAnimate<HTMLDivElement>(replyAnimation);
  // Which reply (if any) is being edited inline — only ever the last human reply,
  // set by the Edit action below.
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  // Selecting text inside any of this card's agent-voiced content — an agent reply
  // or an agent-authored feedback body — raises a "Quote in reply" bubble; clicking
  // it drops the selection into the reply draft as a `>` blockquote and opens the
  // composer, caret past the quote (quoteBlock). Both wear a data-*-author="agent"
  // marker so one closest() over the selector list covers them.
  const eligibleAgentContent = useCallback((range: Range) => {
    const n = range.commonAncestorContainer;
    const el = n instanceof Element ? n : n.parentElement;
    return !!el?.closest('[data-reply-author="agent"], [data-body-author="agent"]');
  }, []);
  const { pos: quotePos, hide: hideQuote } = useQuoteBubble(cardRef, eligibleAgentContent);

  // Edit targets the *last thing the human wrote* — their last reply, or the
  // feedback body if no one has replied. It's disabled once the agent has the last
  // word: don't rewrite the thread out from under a reply they're acting on (post a
  // new reply instead). So Edit is enabled iff the last message is human-authored.
  const lastReply = fb.replies.at(-1) ?? null;
  const lastAuthor: Author = lastReply?.author ?? fb.author;
  const canEdit = lastAuthor === "human";
  // "Your turn": the agent had the last word (the mirror of canEdit) and it isn't
  // resolved — surfaced as an unread-style dot in the header, and what floats this
  // card into the attention zone at the top of the active list.
  const awaitingYou = needsAttention(fb);
  // Either the body or the last human reply is edited at a time; `editText` is the
  // shared buffer and the bottom action row drives Save/Cancel for whichever is live.
  const isEditing = editing || editingReplyId != null;
  const startEdit = () => {
    if (lastReply && lastReply.author === "human") {
      setEditText(lastReply.body);
      setEditingReplyId(lastReply.id);
    } else {
      setEditText(fb.body);
      setEditing(true);
    }
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditingReplyId(null);
  };

  // Post the composer text (if any) as a plain reply and — for Resolve — flip
  // the status. A reply never carries a status itself; a bare Resolve with an
  // empty composer is a pure status toggle, no filler "Resolved." message. The
  // two calls are separate requests.
  //
  // The reply body travels as a mutate *variable*, NOT read from the `reply` draft
  // inside mutationFn: onMutate clears the composer (setReply("")), which
  // re-renders and — because React Query re-syncs a pending mutation's options —
  // swaps mutationFn to a fresh closure that would see the cleared "". Passing the
  // captured body through keeps both legs working off the same immutable value.
  //
  // repliedRef lets onError know whether the reply already reached the server, so a
  // failed resolve *after* a successful reply doesn't restore the composer text
  // (which would double-post it on retry).
  const repliedRef = useRef(false);
  const postReply = useMutation({
    onMutate: async ({ resolve, body }: { resolve: boolean; body: string }) => {
      repliedRef.current = false;
      const prev = await beginPatch();
      const text = body.trim();
      const pending = text ? optimisticReply(body) : null;
      patchThisFeedback((f) => ({
        ...f,
        status: resolve ? "resolved" : f.status,
        replies: pending ? [...f.replies, pending] : f.replies,
      }));
      // Clear the composer instantly so the text isn't shown twice (thread +
      // input); restored in onError only if the reply never actually posted.
      if (text) setReply("");
      // Collapse the composer once the reply lands — the thread now shows it, so
      // the open input has nothing left to hold. "Reply" reopens it for the next.
      setReplyOpen(false);
      // Hand focus to the next item so a top-down pass keeps moving instead of
      // trailing the just-answered card (which sinks out of the attention group)
      // down to the bottom of the list. The parent picks which item; fired here
      // off this render's pre-mutation list. Resolving advances-and-removes; a
      // plain reply advances only if there's a genuinely-next card below.
      if (resolve) onResolved(fb.id);
      else if (text) onReplied(fb.id);
      return { prev, body, tmpId: pending?.id ?? null };
    },
    mutationFn: async ({ resolve, body }: { resolve: boolean; body: string }) => {
      let posted: Reply | null = null;
      if (body.trim()) {
        posted = (await api.addReply(fb.id, { author: "human", body })).reply;
        repliedRef.current = true;
      }
      if (resolve) await api.editFeedback(fb.id, { status: "resolved" });
      return posted;
    },
    onSuccess: (posted, _vars, ctx) => {
      // Swap the stand-in row for the server's authoritative reply (real id,
      // sent_at/ref_version set) so the initiator is consistent even if the SSE
      // echo never arrives (a silently dead EventSource) — without it the tmp row
      // lingers and its Edit would PATCH a nonexistent id. A no-op when the echo's
      // refetch already landed and replaced the whole list.
      if (posted && ctx?.tmpId)
        patchThisFeedback((f) => ({
          ...f,
          replies: f.replies.map((r) => (r.id === ctx.tmpId ? posted : r)),
        }));
    },
    onError: (e, _vars, ctx) => {
      restore(ctx?.prev);
      report(`Couldn't save — ${apiErrorText(e)}`);
      // onMutate advanced focus to the next card; bring it back so the restored
      // draft and the error banner aren't stranded on an unfocused, possibly
      // scrolled-away card. Focus only — the panel scrolls this card into view;
      // the content pane has no reason to move.
      onFocus(fb);
      // The reply never left the browser → put the draft back so it isn't lost. If
      // it did post and only the resolve failed, leave the composer empty: the
      // restore() refetch brings the real reply back and a retry can't dup it.
      if (ctx?.body.trim() && !repliedRef.current) {
        setReply(ctx.body);
        setReplyOpen(true);
      }
    },
  });
  const reopen = useMutation({
    onMutate: async () => {
      const prev = await beginPatch();
      patchThisFeedback((f) => ({ ...f, status: "open" }));
      return { prev };
    },
    mutationFn: () => api.editFeedback(fb.id, { status: "open" }),
    onError: (e, _v, ctx) => {
      restore(ctx?.prev);
      report(`Couldn't save — ${apiErrorText(e)}`);
    },
  });
  const remove = useMutation({
    onMutate: async () => {
      const prev = await beginPatch();
      qc.setQueryData<ReviewDetail>(reviewKey, (d) =>
        d ? { ...d, feedback: d.feedback.filter((f) => f.id !== fb.id) } : d,
      );
      return { prev };
    },
    mutationFn: () => api.deleteFeedback(fb.id),
    onError: (e, _v, ctx) => {
      restore(ctx?.prev);
      report(`Couldn't delete — ${apiErrorText(e)}`);
    },
  });
  // Save an inline edit of the last human message — a reply (`replyId` set) or the
  // feedback body (null). Like postReply, the target + text ride as variables:
  // onMutate calls cancelEdit() (which nulls editingReplyId) and the pending-mutation
  // option re-sync would otherwise make mutationFn read the post-cancel state and
  // edit the wrong target.
  const saveEdit = useMutation({
    onMutate: async ({ replyId, body }: { replyId: string | null; body: string }) => {
      const prev = await beginPatch();
      if (replyId) {
        patchThisFeedback((f) => ({
          ...f,
          replies: f.replies.map((r) => (r.id === replyId ? { ...r, body } : r)),
        }));
      } else {
        patchThisFeedback((f) => ({ ...f, body }));
      }
      // Close the editor instantly to reveal the patched body (the editor renders
      // in place of the body while open, so the change isn't visible until then).
      cancelEdit();
      return { prev, replyId };
    },
    mutationFn: async ({ replyId, body }: { replyId: string | null; body: string }) => {
      if (replyId) await api.editReply(replyId, { body });
      else await api.editFeedback(fb.id, { body });
    },
    onError: (e, _vars, ctx) => {
      restore(ctx?.prev);
      report(`Couldn't save — ${apiErrorText(e)}`);
      // Reopen the editor with the edited text intact so a failed save isn't lost.
      if (ctx?.replyId) setEditingReplyId(ctx.replyId);
      else setEditing(true);
    },
  });

  // Focus the composer the moment it opens (the human clicked "Reply").
  // preventScroll so the browser doesn't yank the off-screen textarea into view —
  // openReply owns where the panel scrolls to.
  useEffect(() => {
    if (replyOpen) replyRef.current?.focus({ preventScroll: true });
  }, [replyOpen]);

  // Close the ⋯ menu on Escape.
  useEscape(menuOpen, () => setMenuOpen(false));

  const resolved = fb.status === "resolved";
  // Show the last three replies by default (a version-pinned answer often splits
  // into more than one reply — old vs. new — so keep a little more of the tail in
  // view); the rest fold behind the expander.
  const earlier = fb.replies.length - 3;

  // The one place a body/reply edit commits from — the body editor's ⌘Enter, each
  // ReplyBlock's Save, and the action-row Save all call this.
  const commitEdit = () => saveEdit.mutate({ replyId: editingReplyId, body: editText });
  // A reply row: the folded "earlier replies" and the visible last-three render the
  // same block, differing only in the slice of `fb.replies` they iterate.
  const renderReply = (rp: Reply) => (
    <ReplyBlock
      key={rp.id}
      rp={rp}
      editing={rp.id === editingReplyId}
      editValue={editText}
      onEditChange={setEditText}
      onEditSave={commitEdit}
      onEditCancel={cancelEdit}
      canSave={editText.trim().length > 0 && !saveEdit.isPending}
      onLocatePin={onLocatePin}
      onJumpRef={(ref) => onJumpRef(ref, rp.ref_version ?? null)}
    />
  );

  // Reveal the composer, then — only if the last agent reply (the message the
  // human is most likely responding to) is scrolled out of view — bring it to the
  // top of the panel. A reply already on screen shouldn't jump under the user. No
  // agent reply → fall back to the composer, gated the same way.
  const openReply = () => {
    const agentReplies = cardRef.current?.querySelectorAll<HTMLElement>(
      '[data-reply-author="agent"]',
    );
    const lastAgent = agentReplies?.[agentReplies.length - 1] ?? null;
    setReplyOpen(true);
    requestAnimationFrame(() => {
      const target = lastAgent ?? replyRef.current;
      if (!target) return;
      // "Out of the screen" = no part of the target overlaps the scroll pane's
      // visible band. If any of it shows, leave the scroll where it is.
      const pane = scrollParent(cardRef.current);
      if (pane) {
        const t = target.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        if (t.bottom > p.top && t.top < p.bottom) return;
      }
      target.scrollIntoView({ behavior: "smooth", block: lastAgent ? "start" : "nearest" });
    });
  };

  // Drop the selected agent-reply text into the reply draft as a `>` blockquote,
  // open the composer, and land the caret on the blank line after it — ready to
  // respond to the quoted passage. Clears the browser selection so the bubble
  // dismisses and refocus goes cleanly to the textarea.
  const quoteIntoReply = (text: string) => {
    const { text: next, caret } = quoteBlock(reply, text);
    setReply(next);
    setReplyOpen(true);
    hideQuote();
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      const el = replyRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // Outlined (border, no resting fill) so it reads as a button without competing
  // with the filled "Reply" — the ⋯ menu beside it stays a bare ghost trigger.
  const resolveOutline = "border border-neutral-300 dark:border-neutral-700";
  const resolveButton = resolved ? (
    // Fainter than Resolve, on purpose: reopening is the exception, not the next
    // step. A resolved thread is a decision already made, and this row shouldn't
    // invite undoing it at the same weight the open card invites finishing it —
    // so the border and label recede until hover brings it back to full strength.
    <Button
      variant="ghost"
      className="border border-neutral-200 text-neutral-400 hover:text-neutral-700 dark:border-neutral-800 dark:text-neutral-500 dark:hover:text-neutral-200"
      disabled={reopen.isPending}
      onClick={() => reopen.mutate()}
    >
      ↺ Reopen
    </Button>
  ) : (
    <Button
      variant="ghost"
      className={resolveOutline}
      disabled={postReply.isPending}
      onClick={() => postReply.mutate({ resolve: true, body: reply })}
      title="Mark resolved"
    >
      ✓ Resolve
    </Button>
  );

  // `r` / `e` arriving from the keyboard layer. Each runs this card's own button
  // onClick, under that button's own `disabled` condition — a keystroke must never
  // fire a mutation the button wouldn't. The ref is seeded at mount so a card
  // remounting under a command it already ran doesn't replay it (see CardCommand).
  const seenCommand = useRef(command?.nonce);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `command` is the trigger; the card's own state is read live when one arrives
  useEffect(() => {
    if (!command || command.nonce === seenCommand.current) return;
    seenCommand.current = command.nonce;
    // While an editor is open the action row is Save/Cancel — neither Reply nor
    // Resolve is on screen, so neither key may act. (The reply composer is inert
    // then too, so the focus below would silently fail anyway.)
    if (isEditing) return;
    if (command.action === "reply") {
      if (!replyOpen) openReply();
      // Put the caret in the box: the click you'd have made next. preventScroll so
      // it doesn't undo openReply's scroll-the-last-agent-reply-into-view; the rAF
      // waits out the Collapse's `inert` clearing on the render openReply queued.
      requestAnimationFrame(() => replyRef.current?.focus({ preventScroll: true }));
    } else if (resolved) {
      if (!reopen.isPending) reopen.mutate();
    } else if (!postReply.isPending) {
      postReply.mutate({ resolve: true, body: reply });
    }
  }, [command]);

  return (
    <div
      ref={cardRef}
      data-fb-card={fb.id}
      className={cn(
        // Embedded block flush to the panel. p-3 keeps content off the edge; a
        // full-bleed bottom rule is the divider (last:border-b-0).
        "relative border-b-2 border-b-neutral-300 border-l-2 border-l-transparent p-3 transition-colors last:border-b-0 dark:border-b-neutral-700",
        // Resolved: a faint success wash, so a resolved card can never be mistaken
        // for open work at a glance. Deliberately the ONE full-card fill in this
        // list: it says "not your queue", which is exactly what a wash says better
        // than a badge alone.
        resolved && "bg-success-50/70 dark:bg-success-950/20",
        // Active feedback: just the amber left rail — no fill (a full-card wash
        // was too loud). The border-l-2 above is always reserved, so activating
        // adds no layout shift. The outdated-anchor state stays on the ⚠ by the
        // file name, not here. The rail stays single-purpose (focus, nothing
        // else): resolved cards arrive already grouped under their own tab, so a
        // second rail colour would be marking a distinction the list has no
        // mixture to draw.
        isActive && "border-l-warning-400 dark:border-l-warning-500",
      )}
    >
      {/* A claimed item is deliberately de-emphasized while the agent owns the
          next move. Use a translucent overlay instead of parent opacity so the
          working badge can sit above it at full emphasis. Pointer events pass
          through: the human can still inspect, reply to, or resolve the card. */}
      {fb.claim && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-neutral-50/45 dark:bg-neutral-950/45"
        />
      )}
      <div className="mb-1.5 flex items-center gap-1.5">
        {/* A span (not a button) so the file:line label is selectable to copy;
            the click still jumps, but a click that concluded a drag-selection is
            treated as "copy, don't jump" (clickEndedInSelection). */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a native button would make the label unselectable; the click is a mouse-only convenience (jump) — copying the text is the point */}
        <span
          onClick={() => {
            if (clickEndedInSelection()) return;
            onLocate(fb);
          }}
          className={cn(
            // flex + min-w-0 so the label's `truncate` clips while the ⚠ (a larger
            // glyph) sits on the same baseline as it, keeping the header on one line.
            "flex min-w-0 cursor-pointer items-baseline gap-1 font-mono text-[0.6875rem] transition-colors select-text",
            // Review-level "general" notes get the accent (violet) used elsewhere
            // for general feedback, to set them apart from file/line positions.
            fb.file
              ? "text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400"
              : "text-accent-500 hover:text-accent-600 dark:text-accent-400 dark:hover:text-accent-300",
          )}
          title={fb.file ? `Jump to ${fb.file}` : undefined}
        >
          {fb.anchor === "outdated" && (
            <span
              title="The code this refers to changed — this anchor may be stale."
              className="shrink-0 text-base leading-none text-warning-500 dark:text-warning-400"
            >
              ⚠
            </span>
          )}
          <span className="truncate">{locLabel(fb)}</span>
        </span>
        {resolved && (
          <span
            title="Resolved — done, not in the active queue. Reopen puts it back."
            className="flex shrink-0 items-center gap-0.5 rounded bg-success-100 px-1 py-px text-[0.625rem] font-medium text-success-800 dark:bg-success-950 dark:text-success-300"
          >
            ✓ resolved
          </span>
        )}
        {fb.author === "agent" && (
          <span
            title="Opened by the agent"
            className="shrink-0 rounded bg-primary-100/60 px-1 py-px text-[0.625rem] font-medium text-primary-700 dark:bg-primary-500/15 dark:text-primary-300"
          >
            agent
          </span>
        )}
        {fb.claim && (
          <span
            title={`${fb.claim.session}${fb.claim.agentId ? ` (${fb.claim.agentId})` : ""} is working on this feedback`}
            className="relative z-20 flex shrink-0 items-center gap-1 rounded-full bg-primary-100 px-1.5 py-px text-[0.625rem] font-medium text-primary-700 dark:bg-primary-950 dark:text-primary-300"
          >
            <span className="size-1.5 rounded-full bg-primary-500" />
            {shortSession(fb.claim.session)} working
          </span>
        )}
        {awaitingYou && (
          <span
            title="The agent replied — your turn."
            className="ml-auto flex shrink-0 items-center"
          >
            <span className="block size-2 rounded-full bg-primary-500 dark:bg-primary-400" />
          </span>
        )}
      </div>

      {fb.quote && (
        // A div (not a button) so the quoted code is selectable to copy; a plain
        // click still toggles expand/collapse, but a drag-selection doesn't
        // (clickEndedInSelection). Expand first, then select the hidden lines.
        // biome-ignore lint/a11y/useKeyWithClickEvents: a native button would make the quote unselectable; the click is a mouse-only convenience (expand) — copying the text is the point
        <div
          onClick={() => {
            if (clickEndedInSelection()) return;
            setQuoteExpanded((v) => !v);
          }}
          title={
            quoteExpanded
              ? "Click to collapse · drag to select"
              : "Click to show the full quote · drag to select"
          }
          className={cn(
            // Mono text-xs = the code font in FileView/DiffView, so a quoted line
            // matches the pane it came from.
            "mb-2 block w-full cursor-pointer border-l-2 border-neutral-300 pl-2 text-left font-mono text-xs text-neutral-500 select-text dark:border-neutral-700 dark:text-neutral-400",
            quoteExpanded
              ? "max-h-40 overflow-auto whitespace-pre-wrap break-words"
              : "line-clamp-2 whitespace-pre-wrap break-words",
          )}
        >
          {fb.quote}
        </div>
      )}

      {editing ? (
        <MessageEditor
          value={editText}
          onChange={setEditText}
          onSubmit={commitEdit}
          onCancel={cancelEdit}
          autoFocus
          className="-mx-3 w-[calc(100%_+_1.5rem)]"
        />
      ) : (
        // The body is the headline of the card — a notch larger than everything
        // else around it — rendered as Markdown. Agent-authored feedback is bound
        // in the same soft primary bubble as the agent's reply blocks: this item
        // is the agent guiding you, not your own note coming back, so it sets
        // itself apart from a human reply (plain prose) in the thread below. The
        // data-body-author marker lets select-to-quote fire on agent-authored body
        // text (same gesture as an agent reply).
        <div data-body-author={fb.author} className={cn(fb.author === "agent" && AGENT_BUBBLE)}>
          <MessageProse
            source={fb.body}
            className="text-sm text-neutral-800 dark:text-neutral-100"
            onJumpRef={(ref) => onJumpRef(ref, fb.patch_seq ?? null)}
          />
        </div>
      )}

      {fb.replies.length > 0 && (
        // No rule between the body and the thread: a human reply is the same voice
        // as the body, so the two flow together on the same gap rhythm as reply →
        // reply (mt-2.5 == the replies' space-y-2.5). Agent bubbles set themselves
        // apart with their tint; human replies read as continued prose.
        <div className="mt-2.5">
          {/* Fold to the last three replies by default (agent replies can be
              essays); an expander slides the earlier ones open above them.
              Collapsed every render. Spacing is manual (not space-y) so the
              folded Collapse contributes no phantom gap. */}
          {earlier > 0 && (
            <>
              <button
                type="button"
                onClick={() => setRepliesExpanded((v) => !v)}
                className="mb-2.5 flex items-center gap-1 text-[0.6875rem] text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                <FoldTriangle open={repliesExpanded} className="size-2.5" />
                {repliesExpanded
                  ? "hide earlier replies"
                  : `${earlier} earlier ${earlier === 1 ? "reply" : "replies"}`}
              </button>
              <Collapse open={repliesExpanded}>
                <div className="space-y-2.5 pb-2.5">{fb.replies.slice(0, -3).map(renderReply)}</div>
              </Collapse>
            </>
          )}
          <div ref={replyAnim} className="space-y-2.5">
            {fb.replies.slice(-3).map(renderReply)}
          </div>
        </div>
      )}

      {/* -mx-3 on Collapse, not the textarea: its overflow-hidden would clip a
          margin on the textarea. Hidden while editing so only the editor shows. */}
      <Collapse open={replyOpen && !isEditing} className="-mx-3">
        <MessageEditor
          textareaRef={replyRef}
          value={reply}
          onChange={setReply}
          onSubmit={() => {
            if (!postReply.isPending) postReply.mutate({ resolve: false, body: reply });
          }}
          // Esc closes the box only when it's empty — with text typed, Esc is a
          // no-op so an accidental press can't discard the draft.
          onCancel={() => {
            if (!reply.trim()) setReplyOpen(false);
          }}
          placeholder={usePlaceholder("Reply", `${SUBMIT_KEYS} to send`)}
          minRows={2}
          className="mt-3 w-full"
        />
      </Collapse>
      <div className="mt-3 flex items-center gap-1 text-[0.6875rem] [&_button]:cursor-default">
        {isEditing ? (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!editText.trim() || saveEdit.isPending}
              onClick={commitEdit}
            >
              Save
            </Button>
          </div>
        ) : (
          <>
            {resolveButton}
            <div className="relative">
              <Button variant="ghost" onClick={() => setMenuOpen((o) => !o)} title="More actions">
                ⋯
              </Button>
              {menuOpen && (
                <>
                  {/* click-catcher: closes the menu when clicking elsewhere */}
                  <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                    className="fixed inset-0 z-40 cursor-default"
                  />
                  <div className="absolute left-0 top-full z-50 mt-1 w-28 overflow-hidden rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
                    {/* Edit the last thing the human wrote (their last reply, else the
                        feedback body). Disabled once the agent replied last — its
                        wording is part of the record they're acting on, so post a new
                        reply instead of editing under them. Delete still works. */}
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => {
                        startEdit();
                        setMenuOpen(false);
                      }}
                      title={
                        canEdit ? undefined : "The agent replied last — post a new reply instead"
                      }
                      className={cn(
                        "block w-full px-3 py-1.5 text-left text-xs",
                        canEdit
                          ? "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                          : "cursor-not-allowed text-neutral-400 dark:text-neutral-600",
                      )}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Delete this feedback and its replies?")) remove.mutate();
                        setMenuOpen(false);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-danger-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            {replyOpen && (
              <button
                type="button"
                aria-label="Discard reply"
                title="Discard reply"
                onClick={() => {
                  setReply("");
                  setReplyOpen(false);
                }}
                // Below md the icon grows a compact touch target matching the
                // min-h-9 Buttons sharing this action row.
                className="ml-auto rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-danger-50 hover:text-danger-600 max-md:flex max-md:size-9 max-md:items-center max-md:justify-center dark:text-neutral-500 dark:hover:bg-danger-950/40 dark:hover:text-danger-400"
              >
                <TrashIcon className="size-4" />
              </button>
            )}
            <Button
              variant="default"
              className={replyOpen ? undefined : "ml-auto"}
              disabled={replyOpen && (!reply.trim() || postReply.isPending)}
              onClick={() =>
                replyOpen ? postReply.mutate({ resolve: false, body: reply }) : openReply()
              }
            >
              {replyOpen ? "Save" : "Reply"}
            </Button>
          </>
        )}
      </div>
      {/* A failed mutation is otherwise silent once its optimistic patch rolls
          back — the card just snaps to its old state — so surface the server's
          message under the action row. The text comes from the panel's cardErrors
          store (set in each onError above, with its own verb baked in) so it
          survives the remount that resolve/reopen/delete cause. */}
      {error && (
        <div className="mt-1 text-[0.6875rem] text-danger-600 dark:text-danger-400">{error}</div>
      )}
      {/* "Quote in reply" bubble for a text selection inside one of this card's
          agent replies. Fixed-positioned (measured off the selection), so it
          escapes the card's overflow. */}
      {quotePos && <QuoteBubble pos={quotePos} label="Quote in reply" onQuote={quoteIntoReply} />}
    </div>
  );
});

// The width of the collapsed dock, in rem — shared with ReviewView so the rail
// and the column it sits in can't disagree, and matched to FileBrowser's `w-8`
// so the two rails read as one pair of shutters on the pane. A class would be the
// obvious spelling, but ReviewView sets the *expanded* dock's width from a
// drag-resize number, and mixing the two spellings on one element is how a stale
// inline width survives the collapse.
