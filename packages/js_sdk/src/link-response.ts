import type { LinkCampaign } from './types.js';

/** The fields every answer that describes a link has (resolve, deferred redeem and match). */
export interface LinkFields {
  readonly linkId: string;
  readonly appId: string;
  readonly routePath: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly campaign: LinkCampaign;
}

const CAMPAIGN_FIELDS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/**
 * Reads `linkId`, `appId`, `routePath`, `payload` and `campaign` of a parsed JSON answer as the
 * contract's "Resolving" section says, or returns `null` when the answer is not a usable link.
 */
export function parseLinkFields(json: unknown): LinkFields | null {
  if (!isRecord(json)) return null;
  const { linkId, appId, routePath, payload, campaign } = json;
  if (
    typeof linkId === 'string' &&
    typeof appId === 'string' &&
    typeof routePath === 'string' &&
    routePath.startsWith('/') &&
    !routePath.startsWith('//')
  ) {
    return {
      linkId,
      appId,
      routePath,
      payload: isRecord(payload) ? payload : {},
      campaign: parseCampaign(campaign),
    };
  }
  return null;
}

/** Keeps the five string fields; anything else, or no object at all, is ignored without error. */
function parseCampaign(value: unknown): LinkCampaign {
  const campaign: { -readonly [Field in keyof LinkCampaign]: string } = {};
  if (!isRecord(value)) return campaign;
  for (const field of CAMPAIGN_FIELDS) {
    // Own properties only: `JSON.parse` output has no inherited ones, a fake transport's might.
    const entry: unknown = Object.prototype.hasOwnProperty.call(value, field)
      ? value[field]
      : undefined;
    if (typeof entry === 'string') campaign[field] = entry;
  }
  return campaign;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
