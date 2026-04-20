CREATE TABLE shipment_status (
    shipment_status_uuid STRING NOT NULL REFERENCES shipment (shipment_uuid),
    shipment_uuid STRING NOT NULL,
    shipment_status STRING NOT NULL,
    shipment_status_tmst TIMESTAMP NOT NULL,
    meta_source_event_names STRING NOT NULL,
    meta_source_event_id_lst STRING NOT NULL,
    meta_source_file_path_lst STRING NOT NULL,
    meta_insert_timestamp TIMESTAMP NOT NULL,
    meta_updated_timestamp TIMESTAMP,
    PRIMARY KEY (shipment_status_uuid)
);
