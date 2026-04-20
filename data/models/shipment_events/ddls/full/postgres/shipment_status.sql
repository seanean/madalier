CREATE TABLE shipment_status (
    shipment_status_uuid TEXT NOT NULL REFERENCES shipment (shipment_uuid),
    shipment_uuid TEXT NOT NULL,
    shipment_status TEXT NOT NULL,
    shipment_status_tmst TIMESTAMPTZ NOT NULL,
    meta_source_event_names TEXT NOT NULL,
    meta_source_event_id_lst TEXT NOT NULL,
    meta_source_file_path_lst TEXT NOT NULL,
    meta_insert_timestamp TIMESTAMPTZ NOT NULL,
    meta_updated_timestamp TIMESTAMPTZ,
    PRIMARY KEY (shipment_status_uuid)
);
