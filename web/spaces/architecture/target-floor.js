export function targetFloor(doc, targetElementId) {
  const target = doc.elements.find((item) => item.id === targetElementId);
  const level = doc.levels.find((item) => item.id === target?.level);
  return {
    level: (level || doc.levels[0]).id,
    allFloors: !target && doc.levels.length > 1,
  };
}
