export async function withPromiseTimeout<T>(
  run: () => Promise<T>,
  timeoutMsRaw: number,
  timeoutErrorPrefix: string
) {
  const timeoutMs = Math.max(100, Number(timeoutMsRaw) || 0);
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${timeoutErrorPrefix}:${timeoutMs}`));
    }, timeoutMs);
    void run()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
