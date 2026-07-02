import { getJobSnapshot } from "@/lib/processJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ jobId: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  const { jobId } = await params;
  const encoder = new TextEncoder();
  let progressInterval: ReturnType<typeof setInterval> | null = null;
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    if (progressInterval) clearInterval(progressInterval);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    progressInterval = null;
    keepAliveInterval = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const push = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        );
      };

      const sendSnapshot = () => {
        const snapshot = getJobSnapshot(jobId);
        if (!snapshot) {
          push("error", { error: "Job not found" });
          cleanup();
          closed = true;
          controller.close();
          return;
        }
        push("progress", snapshot);
        if (snapshot.status !== "processing") {
          cleanup();
          closed = true;
          controller.close();
        }
      };

      sendSnapshot();

      progressInterval = setInterval(sendSnapshot, 700);
      keepAliveInterval = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 15000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
