-- Create the bucket for IFC models
INSERT INTO storage.buckets (id, name, public)
VALUES ('ifc-models', 'ifc-models', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policies to allow anonymous users to upload and update objects
CREATE POLICY "Allow public read access"
ON storage.objects FOR SELECT
USING (bucket_id = 'ifc-models');

CREATE POLICY "Allow public insert"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'ifc-models');

CREATE POLICY "Allow public update"
ON storage.objects FOR UPDATE
USING (bucket_id = 'ifc-models');
