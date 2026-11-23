package com.acme.shop.model;

import static com.acme.shop.util.Strings.capitalize;

import com.acme.shop.util.Strings;
import java.util.ArrayList;
import java.util.List;

public class User extends Entity implements Auditable {

    private final String name;
    private final List<Order> orders = new ArrayList<>();

    public User(long id, String name) {
        super(id);
        this.name = capitalize(name);
    }

    public User(String name) {
        this(0L, name);
    }

    public static User create(String name) {
        return new User(name);
    }

    public String displayName() {
        return Strings.pad(name, 12);
    }

    public void validate() {
        if (name.isEmpty()) {
            throw new IllegalArgumentException("empty name");
        }
    }

    public void save() {
        validate();
        this.touch();
    }

    @Override
    public String describe() {
        return "user:" + super.describe();
    }

    @Override
    public String kind() {
        return "user";
    }

    @Override
    public String label() {
        return displayName();
    }

    public void addOrder(Order order) {
        orders.add(order);
    }
}
