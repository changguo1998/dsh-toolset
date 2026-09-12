# 示例 Python 模块
import os


def top_level(a, b):
    return a + b


class Service:
    def __init__(self, base):
        self.base = base

    def start(self, port: int):
        return port

    async def stop(self,
                   graceful: bool = True,
                   timeout: int = 5):
        return graceful and timeout


def another(x):
    if x:
        def nested():
            return 1
        return nested()
    return 0
