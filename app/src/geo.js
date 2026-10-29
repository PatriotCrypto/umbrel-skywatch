const R_NM = 3440.065;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(lat, lon, bearing, distNm) {
  const d = distNm / R_NM;
  const b = toRad(bearing);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}

export function bboxAround(lat, lon, radiusNm) {
  const dLat = radiusNm / 60;
  const dLon = radiusNm / (60 * Math.max(0.05, Math.cos(toRad(lat))));
  return {
    min_lat: Math.max(-90, lat - dLat), max_lat: Math.min(90, lat + dLat),
    min_lng: Math.max(-180, lon - dLon), max_lng: Math.min(180, lon + dLon),
  };
}

// ADS-B emitter categories
export const CATEGORIES = {
  A0: 'No category info', A1: 'Light aircraft', A2: 'Small aircraft', A3: 'Large aircraft',
  A4: 'High-vortex large (B757)', A5: 'Heavy aircraft', A6: 'High performance', A7: 'Rotorcraft',
  B0: 'No category info', B1: 'Glider / sailplane', B2: 'Lighter-than-air', B3: 'Parachutist / skydiver',
  B4: 'Ultralight / hang glider', B6: 'Unmanned aerial vehicle', B7: 'Space vehicle',
  C0: 'No category info', C1: 'Surface emergency vehicle', C2: 'Surface service vehicle', C3: 'Ground obstruction',
};

// Categories worth a "rare" badge in the spotter log
export const RARE_CATEGORIES = new Set(['A6', 'A7', 'B1', 'B2', 'B3', 'B4', 'B6', 'B7']);

export const EMERGENCY_SQUAWKS = {
  '7500': 'Hijack', '7600': 'Radio failure', '7700': 'General emergency',
};
