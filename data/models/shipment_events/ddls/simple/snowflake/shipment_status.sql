CREATE TABLE shipment_status (
    shipment_status_uuid TEXT NOT NULL,
    shipment_uuid TEXT NOT NULL,
    shipment_status TEXT NOT NULL,
    shipment_status_tmst TIMESTAMP_TZ NOT NULL,
    meta_source_event_names TEXT NOT NULL,
    meta_source_event_id_lst TEXT NOT NULL,
    meta_source_file_path_lst TEXT NOT NULL,
    meta_insert_timestamp TIMESTAMP_TZ NOT NULL,
    meta_updated_timestamp TIMESTAMP_TZ
);
