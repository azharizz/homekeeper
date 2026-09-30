export function pathPosition(points, distance) {
  let remaining = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const length = Math.hypot(...b.map((v, axis) => v - a[axis]));
    if (length > 0 && remaining < length)
      return a.map((v, axis) => v + ((b[axis] - v) * remaining) / length);
    remaining -= length;
  }
  return [...points.at(-1)];
}

export function stepProgress(distance, total, stepLength) {
  const steps = Math.ceil(Math.max(0, total - 1e-9) / stepLength);
  return {
    steps,
    completed:
      distance >= total - 1e-9
        ? steps
        : Math.floor((distance + 1e-9) / stepLength),
    next: Math.min(
      total,
      (Math.floor((distance + 1e-9) / stepLength) + 1) * stepLength,
    ),
  };
}

export function insideWalkingArea(point, polygons) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, z] = ring[i],
        [a, b] = ring[j];
      if (
        z > point[1] !== b > point[1] &&
        point[0] < ((a - x) * (point[1] - z)) / (b - z) + x
      )
        inside = !inside;
    }
    return inside;
  };
  return polygons.some((p) => inRing(p.outer) && !p.holes.some(inRing));
}

export function isClickGesture(delta) {
  return delta <= 2;
}
