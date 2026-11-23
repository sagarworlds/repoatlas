package com.acme.shop.service;

import com.acme.shop.model.User;
import java.util.Optional;

public interface UserRepository {

    User save(User user);

    Optional<User> findByName(String name);

    int count();
}
