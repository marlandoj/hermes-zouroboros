/**
 * approve.ts — verified approval / rejection of a pending candidate.
 *
 * One-shot enforcement: the DB transaction reads `approval_status` and
 * transitions it within the same statement; concurrent CLI invocations from
 * the same email link will see one win and the other reject.
 *
 * Token verification uses hmac.verifyToken (timingSafeEqual + 14d expiry).
 *
 * On approval, the candidate directory is moved Skills/_candidates/<slug>/
 * → Skills/<slug>/ via promote.promote.  All file moves happen INSIDE the DB
 * transaction so a partial failure leaves the row in 'pending' for retry.
 */

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyToken } from './hmac.js';
import { promote, archiveCandidate, compensatePromotion, type PromoteResult } from './promote.js';
import type { EventType } from './types.js';
import { promotionHealthEvidenceHash, recordPromotionHealth } from './candidate-handoff.js';
import {
  appendPromotionEvidence,
  resolveLifecycleMode,
  type GovernedPromotionContext,
  type SkillLifecycleMode,
} from './skill-lifecycle.js';

export interface ApprovalLifecycleContext {
  mode?: SkillLifecycleMode;
  lifecycle_root: string;
  actor: string;
  gate_path?: string;
  now?: string;
}

export interface ApproveInputs {
  db: Database;
  skills_root: string;
  id: string;
  token: string;
  /** Override now for tests. */
  nowSeconds?: number;
  /** Automated promotion is fail-closed unless deterministic replay passed. */
  automated?: boolean;
  lifecycle?: ApprovalLifecycleContext;
}

interface ApprovalLifecycleOutcome {
  disposition: 'ALLOW' | 'WOULD_HOLD';
  subject_hash: string | null;
  receipt_hash?: string;
  evidence_receipt_hash?: string;
}

export type DecideOutcome =
  | {
      ok: true;
      action: 'approved';
      promoted_path: string;
      token_prefix_8: string;
      lifecycle?: ApprovalLifecycleOutcome;
    }
  | { ok: true; action: 'rejected'; archive_path: string; token_prefix_8: string }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_resolved'
        | 'token_invalid'
        | 'token_expired'
        | 'token_missing_secret'
        | 'token_malformed'
        | 'replay_required'
        | 'promotion_failed';
      detail?: string;
      token_prefix_8: string;
    };

interface CrystRow {
  id: string;
  slug: string;
  draft_path: string;
  created_at: number;
  approval_status: 'pending' | 'approved' | 'rejected' | 'expired';
  eval_status: string;
}

function load(db: Database, id: string): CrystRow | undefined {
  return db
    .prepare(
      `SELECT id, slug, draft_path, created_at, approval_status, eval_status
         FROM crystallizations
        WHERE id = ?`,
    )
    .get(id) as CrystRow | undefined;
}

function appendEvent(
  db: Database,
  crystallization_id: string,
  event_type: EventType,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO crystallization_events (crystallization_id, event_type, payload)
     VALUES (?, ?, ?)`,
  ).run(crystallization_id, event_type, JSON.stringify(payload));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function lifecycleSubjectHash(manifestPath: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as { subjectHash?: unknown };
    return typeof value.subjectHash === 'string' ? value.subjectHash : undefined;
  } catch {
    return undefined;
  }
}

export function approveCandidate(i: ApproveInputs): DecideOutcome {
  const now = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  const row = load(i.db, i.id);
  if (!row) {
    return {
      ok: false,
      reason: 'not_found',
      token_prefix_8: i.token.slice(0, 8),
    };
  }
  if (row.approval_status !== 'pending') {
    return {
      ok: false,
      reason: 'already_resolved',
      detail: row.approval_status,
      token_prefix_8: i.token.slice(0, 8),
    };
  }
  if (i.automated && row.eval_status !== 'replay_pass') {
    appendEvent(i.db, row.id, 'rejected', {
      ok: false,
      reason: 'replay_required',
      eval_status: row.eval_status,
      automated: true,
    });
    return {
      ok: false,
      reason: 'replay_required',
      detail: `automated promotion requires replay_pass; found ${row.eval_status}`,
      token_prefix_8: i.token.slice(0, 8),
    };
  }

  const v = verifyToken(
    { id: row.id, created_at: row.created_at, candidate_path: row.draft_path },
    i.token,
    now,
  );
  if (!v.ok) {
    appendEvent(i.db, row.id, 'rejected', {
      ok: false,
      reason: v.reason,
      token_prefix_8: v.token_prefix_8,
    });
    const reasonMap: Record<string, DecideOutcome['ok'] extends false ? string : never> = {} as never;
    void reasonMap;
    return {
      ok: false,
      reason:
        v.reason === 'expired'
          ? 'token_expired'
          : v.reason === 'malformed'
          ? 'token_malformed'
          : v.reason === 'missing-secret'
          ? 'token_missing_secret'
          : 'token_invalid',
      token_prefix_8: v.token_prefix_8,
    };
  }

  const mode = resolveLifecycleMode(i.lifecycle?.mode);
  const manifestPath = join(row.draft_path, 'skill-lifecycle.json');
  const governed: GovernedPromotionContext | undefined = i.lifecycle && mode !== 'off'
    ? {
        mode,
        lifecycle_root: i.lifecycle.lifecycle_root,
        manifest_path: manifestPath,
        approval: {
          kind: i.automated ? 'automated' : 'human',
          actor: i.lifecycle.actor,
          subjectHash: lifecycleSubjectHash(manifestPath),
          tokenHash: sha256(i.token),
        },
        gate_path: i.lifecycle.gate_path,
        now: i.lifecycle.now ?? new Date(now * 1_000).toISOString(),
      }
    : undefined;

  let promotion: PromoteResult;
  try {
    promotion = promote({
      candidate_path: row.draft_path,
      skills_root: i.skills_root,
      slug: row.slug,
      governed,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'promotion_failed',
      detail: err instanceof Error ? err.message : String(err),
      token_prefix_8: v.token_prefix_8,
    };
  }

  let lifecycleOutcome: ApprovalLifecycleOutcome | undefined;
  try {
    i.db.transaction(() => {
      const update = i.db.prepare(
        `UPDATE crystallizations
            SET approval_status = 'approved',
                promoted_path = ?,
                approved_at = ?
          WHERE id = ? AND approval_status = 'pending'`,
      ).run(promotion.promoted_path, now, row.id);
      if (update.changes !== 1) throw new Error('approval row changed before commit');
      const promotionHealth = recordPromotionHealth({
        db: i.db,
        crystallization_id: row.id,
        slug: row.slug,
        promoted_path: promotion.promoted_path,
        nowSeconds: now,
      });
      const lifecycleReceipt = promotion.lifecycle?.receipt;
      const evidenceReceipt = lifecycleReceipt && i.lifecycle
        ? appendPromotionEvidence({
            lifecycle_root: i.lifecycle.lifecycle_root,
            slug: row.slug,
            actor: 'crystallize-promotion-health',
            subject_hash: lifecycleReceipt.subjectHash,
            evidence_hash: promotionHealthEvidenceHash(promotionHealth),
            evidence_kind: 'promotion-health',
            observed_at: new Date(now * 1_000).toISOString(),
          })
        : undefined;
      lifecycleOutcome = promotion.lifecycle
        ? {
            disposition: promotion.lifecycle.advisory.disposition,
            subject_hash: promotion.lifecycle.advisory.gate.subjectHash,
            ...(lifecycleReceipt ? { receipt_hash: lifecycleReceipt.receiptHash } : {}),
            ...(evidenceReceipt ? { evidence_receipt_hash: evidenceReceipt.receiptHash } : {}),
          }
        : undefined;
      appendEvent(i.db, row.id, 'approved', { token_prefix_8: v.token_prefix_8 });
      appendEvent(i.db, row.id, 'promoted', {
        promoted_path: promotion.promoted_path,
        observation: 'reuse_survivability',
        ...promotionHealth,
        ...(lifecycleOutcome
          ? {
              lifecycle_disposition: lifecycleOutcome.disposition,
              lifecycle_subject_hash: lifecycleOutcome.subject_hash,
              lifecycle_receipt_hash: lifecycleOutcome.receipt_hash,
              promotion_health_receipt_hash: lifecycleOutcome.evidence_receipt_hash,
            }
          : {}),
      });
    })();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let compensationDetail = '';
    try {
      const compensation = compensatePromotion({
        candidate_path: row.draft_path,
        skills_root: i.skills_root,
        slug: row.slug,
        governed,
        promotion,
        actor: i.lifecycle?.actor ?? 'crystallize-transaction-compensation',
        reason_hash: sha256(detail),
        observed_at: new Date(now * 1_000).toISOString(),
      });
      if (compensation.lifecycle_error) {
        compensationDetail = `; lifecycle compensation receipt failed: ${compensation.lifecycle_error}`;
      }
    } catch (compensationError) {
      compensationDetail = `; compensation failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`;
    }
    return {
      ok: false,
      reason: 'promotion_failed',
      detail: `${detail}${compensationDetail}`,
      token_prefix_8: v.token_prefix_8,
    };
  }

  return {
    ok: true,
    action: 'approved',
    promoted_path: promotion.promoted_path,
    token_prefix_8: v.token_prefix_8,
    ...(lifecycleOutcome ? { lifecycle: lifecycleOutcome } : {}),
  };
}

export function rejectCandidate(i: ApproveInputs): DecideOutcome {
  const now = i.nowSeconds ?? Math.floor(Date.now() / 1000);
  const row = load(i.db, i.id);
  if (!row) {
    return {
      ok: false,
      reason: 'not_found',
      token_prefix_8: i.token.slice(0, 8),
    };
  }
  if (row.approval_status !== 'pending') {
    return {
      ok: false,
      reason: 'already_resolved',
      detail: row.approval_status,
      token_prefix_8: i.token.slice(0, 8),
    };
  }

  const v = verifyToken(
    { id: row.id, created_at: row.created_at, candidate_path: row.draft_path },
    i.token,
    now,
  );
  if (!v.ok) {
    appendEvent(i.db, row.id, 'rejected', {
      ok: false,
      reason: v.reason,
      token_prefix_8: v.token_prefix_8,
    });
    return {
      ok: false,
      reason:
        v.reason === 'expired'
          ? 'token_expired'
          : v.reason === 'malformed'
          ? 'token_malformed'
          : v.reason === 'missing-secret'
          ? 'token_missing_secret'
          : 'token_invalid',
      token_prefix_8: v.token_prefix_8,
    };
  }

  const archive = archiveCandidate({
    candidate_path: row.draft_path,
    skills_root: i.skills_root,
    slug: row.slug,
    id: row.id,
  });

  i.db.transaction(() => {
    i.db.prepare(
      `UPDATE crystallizations
          SET approval_status = 'rejected',
              approved_at = ?
        WHERE id = ? AND approval_status = 'pending'`,
    ).run(now, row.id);
    appendEvent(i.db, row.id, 'rejected', {
      ok: true,
      archive_path: archive.archive_path,
      token_prefix_8: v.token_prefix_8,
    });
  })();

  return {
    ok: true,
    action: 'rejected',
    archive_path: archive.archive_path,
    token_prefix_8: v.token_prefix_8,
  };
}
