import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/server';

const handlers = auth.handler();

type RouteContext = {
  params: { path: string[] } | Promise<{ path: string[] }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return handlers.GET(request, { params: Promise.resolve(context.params) });
}

export async function POST(request: NextRequest, context: RouteContext) {
  return handlers.POST(request, { params: Promise.resolve(context.params) });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return handlers.PUT(request, { params: Promise.resolve(context.params) });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return handlers.DELETE(request, { params: Promise.resolve(context.params) });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return handlers.PATCH(request, { params: Promise.resolve(context.params) });
}
