package com.acme.shop.model;

public interface Auditable {

    String label();

    default String auditLine() {
        return "audit:" + label();
    }
}
