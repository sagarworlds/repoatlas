package com.acme.shop.model;

/** Base class for all persisted shop objects. */
public abstract class Entity {

    protected final long id;
    private String lastTouch;

    protected Entity(long id) {
        this.id = id;
    }

    public String describe() {
        return "entity#" + id;
    }

    public abstract String kind();

    public void touch() {
        lastTouch = describe();
    }
}
