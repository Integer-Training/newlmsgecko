import { withGatewayNames, type GatewayView } from '@api/services/apprenticeship/gateway-core';
import { listProfileDisplayNames } from '@cio/db/queries/apprenticeship';

// Gecko Apprenticeships — adds the names of whoever ticked gateway items / confirmed the gateway to a GatewayView
// (one lookup, skipped when nobody did). Kept apart from gateway-core so that file stays free of I/O.
export async function nameGatewayActors(view: GatewayView): Promise<GatewayView> {
  const ids = [
    ...new Set([...view.items.map((i) => i.by), view.gatewayPassedBy].filter((x): x is string => Boolean(x)))
  ];
  if (ids.length === 0) return view;
  return withGatewayNames(view, await listProfileDisplayNames(ids));
}
