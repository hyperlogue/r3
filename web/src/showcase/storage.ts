// Display settings in the published showcase last only for this page visit.
const values = new Map<string, string>();
export const memoryStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};
