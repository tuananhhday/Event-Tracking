export const FLOWS = {
  golf: 'Golf', flight: 'Flight', hotel: 'Hotel', combo: 'Combo', attraction: 'VinWonders / Attraction',
  event: 'Sự kiện', train: 'Train', voucher: 'Voucher', merchandise: 'Merchandise', unknown: 'Chưa xác định',
};
const plain = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
export function flowId(value) {
  const text = plain(value);
  return [
    ['golf', /golf/], ['combo', /combo/], ['flight', /flight|ve may bay/], ['hotel', /hotel|khach san/],
    ['voucher', /voucher/], ['merchandise', /merchandise/], ['train', /train|tau hoa/], ['attraction', /vinwonders|attraction|vui choi/], ['event', /^(?:event|su kien)$/],
  ].find(([, pattern]) => pattern.test(text))?.[0] || 'unknown';
}
export function inferEventFlow(event, json) {
  const evidence = [];
  const add = (value, path, kind) => {
    const id = flowId(value); if (id !== 'unknown') evidence.push({ id, path, kind });
  };
  let pageFlow = 'unknown';
  try {
    const url = new URL(event.page?.url);
    // Decoder fallbacks may point at the tracking endpoint, e.g. /api/event.
    // That is not a website "Event" booking flow.
    if (event.layer === 'TRACKING_REQUEST' && event.page?.url === event.network?.url) throw new Error('tracking URL only');
    const path = url.pathname;
    const segment = path.split('/').find(s => /^(golf|flight|hotel|combo|voucher|merchandise|event|train|attraction|vinwonders|ve-may-bay|khach-san)$/.test(s));
    pageFlow = flowId(segment?.replaceAll('-', ' '));
    if (pageFlow !== 'unknown') evidence.push({ id: pageFlow, path: 'page.url', kind: 'page' });
  } catch {}
  for (const [group, values] of Object.entries({ default_parameters: json.default_parameters, custom_parameters: json.custom_parameters })) {
    for (const key of ['taxonomy', 'ta', 'service', 'vertical', 'breadcrumb']) {
      const value = values?.[key];
      for (const item of Array.isArray(value) ? value : [value]) add(item, `${group}.${key}`, 'parameter');
    }
    if (values?.golf_club_id || values?.golf_club_code) add('golf', `${group}.golf_club_id/golf_club_code`, 'parameter');
    if (values?.flight_code || values?.flight_number || values?.departure_code && values?.arrival_code) add('flight', `${group}.flight_code/departure_code`, 'parameter');
    if (values?.hotel_id || values?.hotel_name) add('hotel', `${group}.hotel_id/hotel_name`, 'parameter');
  }
  const named = plain(event.event_name).match(/^(?:search_|search )?(golf|flight|hotel|combo|voucher|merchandise|event|train)(?:_| |$)/);
  if (named) add(named[1], 'event_name', 'event');
  const ids = [...new Set(evidence.map(e => e.id))];
  const id = pageFlow !== 'unknown' ? pageFlow : ids.length === 1 ? ids[0] : 'unknown';
  const comboParts = id === 'combo' && ids.every(f => ['combo', 'hotel', 'flight'].includes(f));
  return { flow_id: id, flow_label: FLOWS[id], flow_conflict: ids.length > 1 && !comboParts, flow_evidence: evidence };
}
