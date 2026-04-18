CREATE TABLE public.adapter_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.adapter_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can request an adapter"
  ON public.adapter_requests
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);