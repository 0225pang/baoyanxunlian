export function GET() {
  return Response.json(
    { error: '完整场次录音已下线，请使用各题独立录音。' },
    { status: 410 },
  );
}
