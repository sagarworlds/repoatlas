package com.acme.shop.service;

import com.acme.shop.model.Order;
import com.acme.shop.model.User;
import com.acme.shop.util.Result;
import com.acme.shop.util.Strings;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class UserService {

    private final UserRepository repo;
    private int known;

    public UserService(UserRepository repo) {
        this.repo = repo;
    }

    public User register(String name) {
        User user = new User(name);
        repo.save(user);
        user.save();
        return user;
    }

    public Order firstOrder(String name) {
        var order = new Order(User.create(name));
        order.addLine(Strings.slug(name), 1);
        return order;
    }

    public Result<User> registerChecked(String name) {
        if (name == null) {
            return Result.fail("no name");
        }
        return Result.ok(register(name));
    }

    public int discountFor(User user) {
        return OrderService.discountPercent(user);
    }

    public String label(String name) {
        String narrow = Strings.pad(name);
        String wide = Strings.pad(name, 10);
        String hidden = Strings.mask(name);
        return narrow + wide + hidden;
    }

    public void handleAll(List<User> users) {
        users.forEach(this::handle);
        users.forEach(u -> audit(u));
        Runnable job = new Runnable() {
            @Override
            public void run() {
                refresh();
            }
        };
        job.run();
    }

    private void handle(User user) {
        user.save();
    }

    private void audit(User user) {
        String line = user.auditLine();
        known += line.length();
    }

    private void refresh() {
        known = repo.count();
    }
}
