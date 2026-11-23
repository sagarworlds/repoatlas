package com.acme.shop.api;

import com.acme.shop.model.User;
import com.acme.shop.service.UserService;
import com.acme.shop.util.*;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {

    private final UserService service;

    public UserController(UserService service) {
        this.service = service;
    }

    @GetMapping("/users")
    public Result<User> create(String name) {
        String clean = Validators.requireNonBlank(name, "name");
        if (!Validators.isEmail(clean)) {
            return Result.fail("bad name");
        }
        User created = service.register(clean);
        return Result.ok(created);
    }

    public String show(String name) {
        User user = service.register(name);
        return Strings.capitalize(user.displayName());
    }
}
