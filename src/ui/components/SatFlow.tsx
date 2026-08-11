import { useMemo, type ReactNode } from 'react';
import {
  layoutSatFlow,
  satFlowEligible,
  satFlowSummary,
  SAT_FLOW_VIEW,
  type SatFlowModel,
  type SatFlowNode,
} from '@drey/core/domain/transactions/sat-flow-layout';
import {
  type SatFlowInscription,
  type SatFlowInput,
  type SatFlowOutput,
  type SatFlowOwnership,
} from '@drey/core/domain/transactions/sat-flow-layout';
import { useI18n, type MessageKey } from '../i18n';
import styles from './SatFlow.module.css';

/**
 * Sat-flow diagram for the transaction review surface (§16.2).
 *
 * Design constraints that shaped this component:
 *
 * - Node text is HTML positioned over an SVG edge layer, not SVG `<text>`.
 *   SVG text neither wraps nor reflows, so it cannot meet the ≥35% text
 *   expansion tolerance (§10.4), and it ignores OS font scaling. The approval
 *   page CSP additionally has no `font-src`, so the display webfont is
 *   unavailable there and metric-based truncation would be unreliable.
 * - No address appears in a node. A truncated address is grindable on prefix
 *   and suffix, so showing one here would add a phishing surface for no gain;
 *   the authoritative output list below carries full addresses. The diagram
 *   shows structure, the list shows identity.
 * - The diagram is strictly additive and never gates approval. When the shape
 *   is ineligible it renders nothing and the caller's list stands alone.
 * - Curves are inert `<path>` elements built from validated integers. No markup
 *   is parsed, no image source is loaded, and there is no animation.
 */

// viewBox padding: headroom above the input row for the "From" caption, and
// room below the output row for movement tags.
const VB_X = 0;
const VB_Y = -16;
const VB_W = SAT_FLOW_VIEW.width;
const VB_H = SAT_FLOW_VIEW.height + 30;

/**
 * Below this node width the descriptive role line ellipsizes to something like
 * "your chan…", which reads worse than omitting it. The amount and the
 * ownership chip stay, and the full picture is in the summary either way.
 */
const NARROW_NODE_WIDTH = 80;

function pct(value: number): string {
  return `${value}%`;
}

const OWNERSHIP = new Set(['wallet', 'external', 'unproven']);
const MOVEMENT = new Set(['received', 'sent', 'retained']);
const INSCRIPTION_ID = /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/u;
/** Bounded so a hostile or corrupt value cannot produce an absurd BigInt. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u;
/*
 * Parse bounds are DoS guards only, deliberately much larger than the diagram's
 * node cap. Whether a shape gets a *picture* is decided by `satFlowEligible`;
 * every parsed shape still gets the plain-language summary, which is where the
 * movement and fee facts actually live.
 */
const MAX_PARSED_NODES = 64;
const MAX_INSCRIPTIONS = 64;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sats(value: unknown): bigint | null {
  return typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : null;
}

/**
 * Independent, fail-closed projection of the approval snapshot into a diagram
 * model. Deliberately does not reuse `parseInscriptionReview`: that parser gates
 * approval, and the diagram must never be able to affect it.
 *
 * Returns null for anything unexpected — a missing field, a skewed shape, an
 * out-of-range index. The caller then renders no diagram and the authoritative
 * output list stands alone. Null is always a safe answer here.
 */
export function parseSatFlowModel(details: unknown): SatFlowModel | null {
  const root = record(details);
  if (!root) return null;

  const security = record(root['security']);
  if (!security) return null;

  const feeSats = sats(root['feeSats']);
  const exposed = sats(security['protectedValueExposedToFees']);
  // A missing exposure figure must not default to zero: that would silently
  // hide the one condition this diagram paints red.
  if (feeSats === null || exposed === null) return null;

  const rawInputs = root['inputs'];
  const rawOutputs = root['outputs'];
  if (!Array.isArray(rawInputs) || !Array.isArray(rawOutputs)) return null;
  if (rawInputs.length < 1 || rawInputs.length > MAX_PARSED_NODES) return null;
  if (rawOutputs.length < 1 || rawOutputs.length > MAX_PARSED_NODES) return null;

  const rawInscriptions = root['inscriptions'] === undefined ? [] : root['inscriptions'];
  if (!Array.isArray(rawInscriptions) || rawInscriptions.length > MAX_INSCRIPTIONS) return null;

  const inscriptions: SatFlowInscription[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawInscriptions) {
    const item = record(raw);
    if (!item) return null;
    const id = item['inscriptionId'];
    const inputIndex = item['inputIndex'];
    const outputIndex = item['outputIndex'];
    const movement = item['movement'];
    const number = item['number'] === undefined ? null : item['number'];
    if (typeof id !== 'string' || !INSCRIPTION_ID.test(id) || seenIds.has(id)) return null;
    if (typeof inputIndex !== 'number' || !Number.isSafeInteger(inputIndex) ||
        inputIndex < 0 || inputIndex >= rawInputs.length) return null;
    if (typeof outputIndex !== 'number' || !Number.isSafeInteger(outputIndex) ||
        outputIndex < 0 || outputIndex >= rawOutputs.length) return null;
    if (typeof movement !== 'string' || !MOVEMENT.has(movement)) return null;
    if (number !== null && (typeof number !== 'number' || !Number.isSafeInteger(number))) return null;
    seenIds.add(id);
    inscriptions.push({
      inscriptionId: id,
      number: number as number | null,
      inputIndex,
      outputIndex,
      movement: movement as SatFlowInscription['movement'],
    });
  }

  const inputs: SatFlowInput[] = [];
  for (let i = 0; i < rawInputs.length; i += 1) {
    const item = record(rawInputs[i]);
    const value = sats(item?.['valueSats']);
    const ownership = item?.['ownership'];
    if (!item || value === null || item['index'] !== i ||
        typeof ownership !== 'string' || !OWNERSHIP.has(ownership)) return null;
    inputs.push({ index: i, valueSats: value, ownership: ownership as SatFlowOwnership });
  }

  const outputs: SatFlowOutput[] = [];
  for (let i = 0; i < rawOutputs.length; i += 1) {
    const item = record(rawOutputs[i]);
    const value = sats(item?.['valueSats']);
    const ownership = item?.['ownership'];
    const role = item?.['role'];
    const committed = item?.['committed'];
    if (!item || value === null || item['index'] !== i ||
        typeof ownership !== 'string' || !OWNERSHIP.has(ownership) ||
        typeof role !== 'string' || typeof committed !== 'boolean') return null;
    // The address is deliberately not carried into the model: the diagram has
    // no field to hold it, so no truncated address can reach a node.
    outputs.push({ index: i, valueSats: value, ownership: ownership as SatFlowOwnership, role, committed });
  }

  return { inputs, outputs, inscriptions, feeSats, protectedValueExposedToFees: exposed };
}

/** Deterministic digit grouping; avoids locale-dependent output in snapshots. */
function groupDigits(value: bigint): string {
  const text = value.toString();
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (i > 0 && (text.length - i) % 3 === 0) out += ',';
    out += text[i];
  }
  return out;
}

function ownershipKey(node: SatFlowNode): MessageKey {
  if (node.kind === 'fee') return 'satflow.owner.fee';
  if (node.ownership === 'wallet') return 'satflow.owner.you';
  if (node.ownership === 'unproven') return 'satflow.owner.unknown';
  return 'satflow.owner.them';
}

function roleKey(node: SatFlowNode): MessageKey | null {
  if (node.kind === 'fee') return 'satflow.role.fee';
  if (node.kind === 'input') return node.carriesInscription ? 'satflow.role.inscription' : 'satflow.role.cardinal';
  switch (node.role) {
    case 'recipient': return 'satflow.role.recipient';
    case 'payment_change': return 'satflow.role.change';
    case 'ordinal_change': return 'satflow.role.ordinalChange';
    case 'postage': return 'satflow.role.postage';
    default: return null;
  }
}

function movementKey(movement: 'received' | 'sent' | 'retained'): MessageKey {
  if (movement === 'received') return 'satflow.movement.received';
  if (movement === 'sent') return 'satflow.movement.sent';
  return 'satflow.movement.retained';
}

function FlowNode(props: { node: SatFlowNode }): ReactNode {
  const { t } = useI18n();
  const { node } = props;
  const role = roleKey(node);
  // Movement describes where an inscription lands, so it belongs on the
  // destination only. Repeating it under the source is noise in a 420px window.
  const movement = node.kind === 'input' ? undefined : node.inscriptions[0]?.movement;

  const classes = [styles['node']];
  if (node.danger) classes.push(styles['nodeDanger']!);
  else if (!node.committed) classes.push(styles['nodeUncommitted']!);
  else if (node.kind === 'fee') classes.push(styles['nodeFee']!);
  else if (node.ownership === 'wallet') classes.push(styles['nodeMine']!);
  if (node.ownership === 'unproven') classes.push(styles['nodeUnproven']!);

  // A node carrying exactly one inscription leads with its number; several
  // co-located inscriptions lead with the count, because no single number
  // represents the group.
  const headline = node.inscriptions.length === 1 && node.inscriptions[0]!.number !== null
    ? `#${node.inscriptions[0]!.number}`
    : node.inscriptions.length > 1
      ? t('satflow.coLocated', { count: node.inscriptions.length })
      : groupDigits(node.valueSats);

  return (
    <li
      className={classes.join(' ')}
      style={{
        left: pct(((node.x - VB_X) / VB_W) * 100),
        top: pct(((node.y - VB_Y) / VB_H) * 100),
        width: pct((node.width / VB_W) * 100),
        height: pct((node.height / VB_H) * 100),
      }}
    >
      <span className={styles['headline']}>{headline}</span>
      {role === null || node.width < NARROW_NODE_WIDTH
        ? null
        : <span className={styles['role']}>{t(role)}</span>}
      <span className={styles['owner']}>{t(ownershipKey(node))}</span>
      {movement === undefined ? null : (
        <span className={styles['movement']}>{t(movementKey(movement))}</span>
      )}
      {node.committed ? null : (
        <span className={styles['uncommittedTag']}>{t('satflow.uncommitted')}</span>
      )}
    </li>
  );
}

export function SatFlow(props: { model: SatFlowModel }): ReactNode {
  const { t } = useI18n();
  const { model } = props;

  const layout = useMemo(() => {
    if (!satFlowEligible(model)) return null;
    try {
      return layoutSatFlow(model);
    } catch {
      // Never let a presentation failure interfere with the review; the caller's
      // output list remains authoritative.
      return null;
    }
  }, [model]);

  const summary = satFlowSummary(model);
  const inscriptionCount = summary.sent + summary.retained + summary.received;

  // The summary carries every fact the picture encodes and is rendered whether
  // or not the picture is, so nothing is available only from the diagram
  // (§10.4). Large transactions get the summary alone.
  const lines: string[] = [];
  if (summary.sent > 0) lines.push(t('satflow.summary.sent', { count: summary.sent }));
  if (summary.retained > 0) lines.push(t('satflow.summary.retained', { count: summary.retained }));
  if (summary.received > 0) lines.push(t('satflow.summary.received', { count: summary.received }));
  if (inscriptionCount === 0) lines.push(t('satflow.summary.none'));
  lines.push(t('satflow.summary.shape', {
    inputs: summary.inputCount,
    outputs: summary.outputCount,
    fee: groupDigits(summary.feeSats),
  }));

  return (
    <section className={styles['flow']} aria-labelledby="sat-flow-heading">
      <div className={styles['head']}>
        <h2 className={styles['title']} id="sat-flow-heading">{t('satflow.heading')}</h2>
        <span className={styles['proof']}>
          {inscriptionCount > 0 ? t('satflow.proven') : t('satflow.valueOnly')}
        </span>
      </div>

      {layout === null ? null : (
        <SatFlowCanvas layout={layout} />
      )}

      <ul className={styles['summary']}>
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>

      {summary.uncommittedOutputCount > 0 ? (
        <p className={styles['caution']} role="alert">
          {t('satflow.summary.uncommitted', { count: summary.uncommittedOutputCount })}
        </p>
      ) : null}

      {summary.protectedValueExposedToFees > 0n ? (
        <p className={styles['risk']} role="alert">
          {t('satflow.summary.feeRisk', {
            sats: groupDigits(summary.protectedValueExposedToFees),
          })}
        </p>
      ) : null}

      {layout === null ? null : (
        <p className={styles['legend']}>
          {inscriptionCount > 0 ? t('satflow.legend.proven') : t('satflow.legend.value')}
        </p>
      )}
    </section>
  );
}

function SatFlowCanvas(props: { layout: NonNullable<ReturnType<typeof layoutSatFlow>> }): ReactNode {
  const { t } = useI18n();
  const { layout } = props;
  const inputs = layout.nodes.filter((node) => node.kind === 'input');
  const outputs = layout.nodes.filter((node) => node.kind !== 'input');

  return (
    <div className={styles['canvas']}>
      {/*
        Edges are decorative: every fact they encode also appears as text in the
        node list here and in the summary below.
      */}
      <svg
        aria-hidden="true"
        className={styles['edges']}
        focusable="false"
        preserveAspectRatio="none"
        viewBox={`${VB_X} ${VB_Y} ${VB_W} ${VB_H}`}
      >
        {layout.edges.map((edge) => {
          const classes = [styles['edge']!];
          if (edge.kind === 'inscription') classes.push(styles['edgeProven']!);
          else if (edge.danger) classes.push(styles['edgeDanger']!);
          else if (edge.uncommitted) classes.push(styles['edgeUncommitted']!);
          else if (edge.kind === 'fee') classes.push(styles['edgeFee']!);
          else classes.push(styles['edgeValue']!);
          return <path className={classes.join(' ')} d={edge.d} key={edge.key} />;
        })}
        <circle
          className={styles['confluenceRing']}
          cx={layout.confluence.x}
          cy={layout.confluence.y}
          r={7}
        />
        <circle
          className={styles['confluenceDot']}
          cx={layout.confluence.x}
          cy={layout.confluence.y}
          r={2.5}
        />
      </svg>

      <p className={styles['rowLabelFrom']}>{t('satflow.from')}</p>
      <ul aria-label={t('satflow.from')} className={styles['nodes']}>
        {inputs.map((node) => <FlowNode key={node.key} node={node} />)}
      </ul>

      <p className={styles['rowLabelTo']}>{t('satflow.to')}</p>
      <ul aria-label={t('satflow.to')} className={styles['nodes']}>
        {outputs.map((node) => <FlowNode key={node.key} node={node} />)}
      </ul>
    </div>
  );
}
