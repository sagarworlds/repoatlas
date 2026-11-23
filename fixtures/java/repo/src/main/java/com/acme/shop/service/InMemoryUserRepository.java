package com.acme.shop.service;

import com.acme.shop.model.User;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

public class InMemoryUserRepository implements UserRepository {

    private final Map<String, User> byName = new HashMap<>();

    @Override
    public User save(User user) {
        user.validate();
        byName.put(user.displayName(), user);
        return user;
    }

    @Override
    public Optional<User> findByName(String name) {
        return Optional.ofNullable(byName.get(name));
    }

    @Override
    public int count() {
        return byName.size();
    }
}
