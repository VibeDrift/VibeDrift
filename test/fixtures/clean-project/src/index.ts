import express from 'express';

const app = express();

export async function startServer(port: number): Promise<void> {
  try {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

export function healthCheck(): { status: string } {
  return { status: 'ok' };
}
