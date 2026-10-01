export function GET() {
  return Response.json({ pinRequired: !!process.env.HOST_PIN?.trim() });
}
