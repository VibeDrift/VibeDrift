import readline from "readline";

/** Ask a yes/no question on stdin; resolves true only for "y"/"yes" (case-insensitive). */
export async function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
