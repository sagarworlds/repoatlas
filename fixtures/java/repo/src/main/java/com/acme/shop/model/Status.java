package com.acme.shop.model;

public enum Status {
    NEW("new"),
    PAID("paid"),
    SHIPPED("shipped");

    private final String text;

    Status(String text) {
        this.text = text;
    }

    public String label() {
        return text;
    }

    public String shout() {
        return label() + "!";
    }

    public Status next() {
        return this == NEW ? PAID : SHIPPED;
    }
}
