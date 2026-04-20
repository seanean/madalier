CREATE TABLE shipment (
    shipment_uuid TEXT NOT NULL,
    shipment_business_id TEXT NOT NULL,
    shipment_technical_id TEXT NOT NULL,
    shipment_type TEXT NOT NULL,
    meta_source_event_names TEXT NOT NULL,
    meta_source_event_id_lst TEXT NOT NULL,
    meta_source_file_path_lst TEXT NOT NULL,
    meta_insert_timestamp TIMESTAMPTZ NOT NULL,
    meta_updated_timestamp TIMESTAMPTZ,
    PRIMARY KEY (shipment_uuid)
);
